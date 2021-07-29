/*
 * session-launcher.ts
 *
 * Copyright (C) 2021 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { app, dialog } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';

import { logger } from '../core/logger';
import { FilePath } from '../core/file-path';
import { generateShortenedUuid, localPeer } from '../core/system';
import { Err, success } from '../core/err';
import { getenv, setenv, unsetenv } from '../core/environment';
import { renderTemplateFile } from '../core/template-filter';
import { readStringArrayFromFile } from '../core/file-serializer';
import { kRStudioInitialProject } from '../core/r-user-data';

import { ApplicationLaunch } from './application-launch';
import { appState } from './app-state';
import { DesktopActivation } from './activation-overlay';
import { EXIT_FAILURE } from './program-status';
import { closeAllSatellites, MainWindow } from './main-window';
import { PendingQuit } from './gwt-callback';
import { finalPlatformInitialize, getCurrentlyUniqueFolderName, userLogPath } from './utils';
import { productInfo } from './product-info';
import { DesktopOptions } from './desktop-options';

export interface LaunchContext {
  host: string;
  port: number;
  url: string;
  argList: string[]
}

let fallbackInstance: string | null = null;

/**
 * @returns A "probably unique" temporary folder name (folder isn't created by this call)
 */
function fallbackLibraryPath(): string {
  if (!fallbackInstance) {
    fallbackInstance = getCurrentlyUniqueFolderName('rstudio-fallback-library-path-').getAbsolutePath();
  }
  return fallbackInstance;
}

function launchProcess(absPath: FilePath, argList: string[]): ChildProcess {
  if (process.platform === 'darwin') {
    // on macOS with the hardened runtime, we can no longer rely on dyld
    // to lazy-load symbols from libR.dylib; to resolve this, we use
    // DYLD_INSERT_LIBRARIES to inject the library we wish to use on
    // launch 
    const rHome = new FilePath(getenv('R_HOME'));
    const rLib = rHome.completePath('lib/libR.dylib');
    if (rLib.existsSync()) {
      setenv('DYLD_INSERT_LIBRARIES', rLib.getAbsolutePath());
    }
   
    // Create fallback library path (use TMPDIR so it's user-specific):
    // Reticulate needs to do some DYLD_FALLBACK_LIBRARY_PATH shenanigans to work with Anaconda Python;
    // the solution is to have RStudio launch with a special DYLD_FALLBACK_LIBRARY_PATH, and let 
    // reticulate set the associated path to a symlink of its choosing on load.
    const libraryPath = fallbackLibraryPath();

    // set it in environment variable (to be used by R)
    setenv('RSTUDIO_FALLBACK_LIBRARY_PATH', libraryPath);

    // and ensure it's placed on the fallback library path
    const dyldFallbackLibraryPath =
      `${getenv('DYLD_FALLBACK_LIBRARY_PATH')}:${libraryPath}`;
    setenv('DYLD_FALLBACK_LIBRARY_PATH', dyldFallbackLibraryPath);
  }
   
  if (!appState().runDiagnostics) {
    return spawn(absPath.getAbsolutePath(), argList);
  } else {
    // for diagnostics, redirect child process stdio to this process
    return spawn(absPath.getAbsolutePath(), argList, { stdio: 'inherit' });
  }
}

function abendLogPath(): FilePath {
  return userLogPath().completePath('rsession_abort_msg.log');
}

export class SessionLauncher {
  host = '127.0.0.1';
  sessionProcess?: ChildProcess;
  mainWindow?: MainWindow;
  static launcherToken = generateShortenedUuid();
  sessionStdout: string[] = [];
  sessionStderr: string[] = [];

  constructor(
    private sessionPath: FilePath,
    private confPath: FilePath,
    private filename: FilePath,
    private appLaunch: ApplicationLaunch
  ) { }

  launchFirstSession(): void {
    appState().activation().on(DesktopActivation.LAUNCH_FIRST_SESSION, this.onLaunchFirstSession.bind(this));
    appState().activation().on(DesktopActivation.LAUNCH_ERROR, this.onLaunchError.bind(this));

    // This will ultimately trigger one of the above events to continue with startup (or failure).
    appState().activation().getInitialLicense();
  }

  // Porting note: In the C++ code this was an overload of launchFirstSession(), but
  // but that isn't a thing in TypeScript (at least not without some ugly workarounds)
  // so giving a different name.
  private launchFirst(): Err {
    // build a new new launch context
    const launchContext = this.buildLaunchContext();

    // show help home on first run
    launchContext.argList.push('--show-help-home', '1');

    logger().logDiagnostic('\nAttempting to launch R session...');
    logger().logDiagnosticEnvVar('RSTUDIO_WHICH_R');
    logger().logDiagnosticEnvVar('R_HOME');
    logger().logDiagnosticEnvVar('R_DOC_DIR');
    logger().logDiagnosticEnvVar('R_INCLUDE_DIR');
    logger().logDiagnosticEnvVar('R_SHARE_DIR');
    logger().logDiagnosticEnvVar('R_LIBS');
    logger().logDiagnosticEnvVar('R_LIBS_USER');
    logger().logDiagnosticEnvVar('DYLD_LIBRARY_PATH');
    logger().logDiagnosticEnvVar('DYLD_FALLBACK_LIBRARY_PATH');
    logger().logDiagnosticEnvVar('LD_LIBRARY_PATH');
    logger().logDiagnosticEnvVar('PATH');
    logger().logDiagnosticEnvVar('HOME');
    logger().logDiagnosticEnvVar('R_USER');
    logger().logDiagnosticEnvVar('RSTUDIO_CPP_BUILD_OUTPUT');

    // launch the process
    try {
      this.sessionProcess = this.launchSession(launchContext.argList);
    } catch (err) {
      return err;
    }

    logger().logDiagnostic( `\nR session launched, attempting to connect on port ${launchContext.port}...`);

    this.mainWindow = new MainWindow(launchContext.url);
    this.mainWindow.sessionLauncher = this;
    this.mainWindow.setSessionProcess(this.sessionProcess);
    this.mainWindow.appLauncher = this.appLaunch;
    this.appLaunch.setActivationWindow(this.mainWindow);

    DesktopOptions().restoreMainWindowBounds(this.mainWindow.window);

    logger().logDiagnostic('\nConnected to R session, attempting to initialize...\n');

    // TODO - reimplement
    // one-time workbench initialized hook for startup file association
    // if (!filename_.isNull() && !filename_.isEmpty()) {
    //   StringSlotBinder* filenameBinder = new StringSlotBinder(filename_);
    //   // use 'once' here so it only fires for the first session
    //   this.mainWindow?.once(MainWindow.FIRST_WORKBENCH_INITIALIZED, filenameBinder);
    //   pMainWindow_->connect(filenameBinder,
    //                         SIGNAL(triggered(QString)),
    //                         pMainWindow_,
    //                         SLOT(openFileInRStudio(QString)));
    // }

    // TODO - reimplement
    // pMainWindow_->connect(pAppLaunch_,
    //                       SIGNAL(openFileRequest(QString)),
    //                       pMainWindow_,
    //                       SLOT(openFileInRStudio(QString)));
    // pMainWindow_->connect(pRSessionProcess_,
    //                       SIGNAL(finished(int,QProcess::ExitStatus)),
    //                       this, SLOT(onRSessionExited(int,QProcess::ExitStatus)));
    // pMainWindow_->connect(&activation(),
    //                       SIGNAL(licenseLost(QString)),
    //                       pMainWindow_,
    //                       SLOT(onLicenseLost(QString)));
    // pMainWindow_->connect(&activation(), &DesktopActivation::updateLicenseWarningBar,
    //                       pMainWindow_, &MainWindow::onUpdateLicenseWarningBar);


    // show the window (but don't if we are doing a --run-diagnostics)
    if (!appState().runDiagnostics) {
      finalPlatformInitialize(this.mainWindow);
      this.mainWindow.window.once('ready-to-show', () => {
        this.mainWindow?.window.show();
      });
      appState().activation().setMainWindow(this.mainWindow.window);
      this.appLaunch.activateWindow();
      this.mainWindow.loadUrl(launchContext.url);
    }

    return success();
  }

  closeAllSatellites(): void {
    if (this.mainWindow) {
      closeAllSatellites(this.mainWindow.window);
    }
  }

  /**
   * @returns [logFileName, logContents]
   */
  async getRecentSessionLogs(): Promise<[string, string]> {
    // Collect R session logs
    const logs = new Array<FilePath>();

    const error = userLogPath().getChildren(logs);
    if (error) {
      throw error;
    }

    // Sort by recency in case there are several session logs --
    // inverse sort so most recent logs are first
    logs.sort((a, b) => {
      return b.getLastWriteTimeSync() - a.getLastWriteTimeSync();
    });

    let logFile = '';

    // Loop over all the log files and stop when we find a session log
    // (desktop logs are also in this folder)
    for (const log of logs) {
      if (log.getFilename().includes('rsession')) {
        // Record the path where we found the log file
        logFile = log.getAbsolutePath();

        // Read all the lines from a file into a string vector
        const [lines, error] = await readStringArrayFromFile(log);
        if (error) {
          throw error;
        }

        // Combine the three most recent lines
        let logContents = '';
        for (let i = Math.max(lines.length - 3, 0); i < lines.length; i++) {
          logContents += lines[i] + '\n';
        }
        return [logFile, logContents];
      }
    }
 
    // No logs found
    return ['Log File', '[No logs available]'];
  }

  async showLaunchErrorPage(): Promise<void> {
    // String mapping of template codes to diagnostic information
    const vars = new Map<string, string>();

    const info = productInfo();
    const gitCommit = info.RSTUDIO_GIT_COMMIT.substr(0, 8);

    // Create version string
    const ss =
      `RStudio ${info.RSTUDIO_VERSION} "${info.RSTUDIO_RELEASE_NAME} " (${gitCommit}, ${info.RSTUDIO_BUILD_DATE}) for ${info.RSTUDIO_PACKAGE_OS}`;
    vars.set('version', ss);

    // Collect message from the abnormal end log path
    if (abendLogPath().existsSync()) {
      vars.set('launch_failed', this.launchFailedErrorMessage());
    } else {
      vars.set('launch_failed', '[No error available]');
    }

    // Collect the rsession process exit code
    let exitCode = EXIT_FAILURE;
    if (this.sessionProcess && this.sessionProcess.exitCode) {
      exitCode = this.sessionProcess.exitCode;
    }
    vars.set('exit_code', exitCode.toString());

    // Read standard output and standard error streams
    let procStdout = this.sessionStdout.join();
    if (!procStdout) {
      procStdout = '[No output emitted]';
    }
    vars.set('process_output', procStdout);

    let procStderr = this.sessionStderr.join();
    if (!procStderr) {
      procStderr = '[No errors emitted]';
    }
    vars.set('process_error', procStderr);

    // Read recent entries from the rsession log file
    let [logFile, logContent] = ['', ''];
    try {
      [logFile, logContent] = await this.getRecentSessionLogs();
    } catch (error) {
      logger().logError(error);
    }
    vars.set('log_file', logFile);
    vars.set('log_content', logContent);

    this.mainWindow?.loadHtml(renderTemplateFile(appState().resourcesPath().completePath('html/error.html'), vars));
    this.mainWindow?.setErrorDisplayed();
  }

  onRSessionExited(): void {
    // if this is a verify-installation session then just quit
    if (appState().runDiagnostics) {
      this.mainWindow?.quit();
      return;
    }

    const pendingQuit = this.mainWindow?.collectPendingQuitRequest();

    // if there was no pending quit set then this is a crash
    if (pendingQuit === PendingQuit.PendingQuitNone) {

      this.closeAllSatellites();

      this.mainWindow?.window.webContents.executeJavaScript('window.desktopHooks.notifyRCrashed()')
        .catch(() => {
          // The above can throw if the window has no desktop hooks; this is normal
          // if we haven't loaded the initial session.
        });

      if (!this.mainWindow?.workbenchInitialized) {
        // If the R session exited without initializing the workbench, treat it as
        // a boot failure.
        void this.showLaunchErrorPage();
      }

      // quit and exit means close the main window
    } else if (pendingQuit === PendingQuit.PendingQuitAndExit) {
      this.mainWindow?.quit();
    }

    // otherwise this is a restart so we need to launch the next session
    else {

      // TODO
      // if (!activation().allowProductUsage())
      // {
      //    std::string message = "Unable to obtain a license. Please restart RStudio to try again.";
      //    std::string licenseMessage = activation().currentLicenseStateMessage();
      //    if (licenseMessage.empty())
      //       licenseMessage = "None Available";
      //    message += "\n\nDetails: ";
      //    message += licenseMessage;
      //    showMessageBox(QMessageBox::Critical,
      //                   pMainWindow_,
      //                   desktop::activation().editionName(),
      //                   QString::fromUtf8(message.c_str()), QString());
      //    closeAllSatellites();
      //    pMainWindow_->quit();
      //    return;
      // }

      // close all satellite windows if we are reloading
      const reload = (pendingQuit === PendingQuit.PendingQuitRestartAndReload);
      if (reload) {
        this.closeAllSatellites();
      }

      // launch next session
      const error = this.launchNextSession(reload);
      if (error) {
        logger().logError(error);

        // TODO
        //  showMessageBox(QMessageBox::Critical,
        //                 pMainWindow_,
        //                 desktop::activation().editionName(),
        //                 launchFailedErrorMessage(), QString());

        this.mainWindow?.quit();
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  launchNextSession(reload: boolean): Err {

    // unset the initial project environment variable it this doesn't
    // pollute future sessions
    unsetenv(kRStudioInitialProject);

    // disconnect the firstWorkbenchInitialized event so it doesn't occur
    // again when we launch the next session
    // porting note: this is handled by using 'once' for the connection

    // delete the old process object
    this.mainWindow?.setSessionProcess(undefined);

    // TODO REVIEW: the C++ code is potentially relying on destructor here; do we need
    // to do more work directly here to disconnect events, etc?
    this.sessionProcess = undefined;

    // build a new launch context -- re-use the same port if we aren't reloading
    const launchContext = this.buildLaunchContext(!reload);

    // launch the process
    try {
      this.sessionProcess = this.launchSession(launchContext.argList);
    } catch (err) {
      return err;
    }

    // update the main window's reference to the process object
    this.mainWindow?.setSessionProcess(this.sessionProcess);

    // TODO REVIEW, still needed?
    // connect to quit event
    // this.mainWindow?.connect(pRSessionProcess_,
    //   SIGNAL(finished(int, QProcess:: ExitStatus)),
    //   this,
    //   SLOT(onRSessionExited(int, QProcess:: ExitStatus)));
    //
    if (reload) {
      logger().logErrorMessage('reloading a session not yet fully implemented');
      // TODO: this mechanism, once recreated, might also be usable for dealing with the
      // initial loading retries, per: https://github.com/rstudio/rstudio/issues/9627
      //     const error = core::waitWithTimeout(
      //              boost::bind(serverReady, host.toStdString(), port.toStdString()),
      //              50,
      //              25,
      //              10);
      //     if (error)
      //        LOG_ERROR(error);
      
    //     nextSessionUrl_ = url;
    //     QTimer::singleShot(0, this, SLOT(onReloadFrameForNextSession()));
    }

    return success();
  }

  onReloadFrameForNextSession(): void {
    // TODO
  }

  private onLaunchFirstSession(): void {
    const error = this.launchFirst();
    if (error) {
      logger().logError(error);
      appState().activation().emitLaunchError(this.launchFailedErrorMessage());
    }
  }

  private launchSession(argList: string[]): ChildProcess {
    // always remove the abend log path before launching
    const error = abendLogPath().removeIfExistsSync();
    if (error) {
      logger().logError(error);
    }

    this.sessionStdout = [];
    this.sessionStderr = [];

    if (appState().sessionStartDelaySeconds > 0) {
      setenv('RSTUDIO_SESSION_SLEEP_ON_STARTUP', appState().sessionStartDelaySeconds.toString());
    }
    if (appState().sessionEarlyExitCode !== 0) {
      setenv('RSTUDIO_SESSION_EXIT_ON_STARTUP', appState().sessionEarlyExitCode.toString());
    }

    // TODO
    // we need indirection through arch to handle arm64
    // see C++ sources...

    const sessionProc = launchProcess(this.sessionPath, argList);
    sessionProc.on('error', (err) => {
      // Unable to start rsession (at all)
      logger().logError(err);
      this.onRSessionExited();
    });
    sessionProc.on('exit', (code, signal) => {
      if (code !== null) {
        logger().logDebug(`rsession exited: code=${code}`);
        if (code !== 0) {
          logger().logDebug(`${this.sessionPath} ${argList}`);
        }
      } else {
        logger().logDebug(`rsession terminated: signal=${signal}`);
      }
      this.onRSessionExited();
    });

    // capture stdout and stderr for diagnostics
    sessionProc.stdout?.on('data', (data) => {
      this.sessionStdout.push(data);
    });
    sessionProc.stderr?.on('data', (data) => {
      this.sessionStderr.push(data);
    });

    return sessionProc;
  }

  onLaunchError(message: string): void {
    if (message) {
      dialog.showErrorBox(appState().activation().editionName(), message);
    }
    if (this.mainWindow) {
      this.mainWindow.window.close();
    } else {
      app.exit(EXIT_FAILURE);
    }
  }

  collectAbendLogMessage(): string {
    let contents = '';
    const abendLog = abendLogPath();
    if (abendLog.existsSync()) {
      try {
        contents = fs.readFileSync(abendLog.getAbsolutePath(), 'utf8');
      } catch (error) {
        logger().logError(error);
      } finally {
        abendLog.removeIfExistsSync();
      }
    }
    return contents;
  }

  launchFailedErrorMessage(): string {
    let errMsg = 'The R session had a fatal error.';

    // check for abend log
    const abendLogMessage = this.collectAbendLogMessage();

    // check for R version mismatch
    if (abendLogMessage.includes('arguments passed to .Internal')) {
      errMsg = errMsg +
        '\n\nThis error was very likely caused ' +
        'by R attempting to load packages from a different ' +
        'incompatible version of R on your system. Please remove ' +
        'other versions of R and/or remove environment variables ' +
        'that reference libraries from other versions of R ' +
        'before proceeding.';
    }

    if (abendLogMessage) {
      errMsg += '\n\n' + abendLogMessage;
    }

    // check for stderr
    const errmsgs = this.sessionStderr.join();
    if (errmsgs) {
      errMsg += '\n\n' + errmsgs;
    }

    return errMsg;
  }

  buildLaunchContext(reusePort = true): LaunchContext {
    const argList: string[] = [];

    if (!reusePort) {
      appState().generateNewPort();
    }

    if (!this.confPath.isEmpty()) {
      argList.push('--config-file', this.confPath.getAbsolutePath());
    } else {
      // explicitly pass "none" so that rsession doesn't read an
      // /etc/rstudio/rsession.conf file which may be sitting around
      // from a previous configuration or install
      argList.push('--config-file', 'none');
    }

    const portStr = appState().port.toString();

    argList.push('--program-mode', 'desktop');
    argList.push('--www-port', portStr);
    argList.push('--launcher-token', SessionLauncher.launcherToken);

    // recalculate the local peer and set RS_LOCAL_PEER so that
    // rsession and it's children can use it
    if (process.platform === 'win32') {
      setenv('RS_LOCAL_PEER', localPeer(appState().port));
    }

    if (appState().runDiagnostics) {
      argList.push('--verify-installation', '1');
    }

    return {
      host: this.host,
      port: appState().port,
      url: `http://${this.host}:${portStr}`,
      argList
    };
  }
}