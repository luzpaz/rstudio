/*
 * RmdEditorOptions.java
 *
 * Copyright (C) 2022 by RStudio, PBC
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

package org.rstudio.studio.client.rmarkdown.model;

public class RmdEditorOptions
{
   public static boolean getBool(String yaml, String option,
         Boolean defaultValue)
   {
      YamlTree yamlTree = new YamlTree(yaml);
      
      String value = yamlTree.getChildValue(EDITOR_OPTION_KEY_V2, option)
            .trim().toLowerCase();
      if (value.isEmpty())
      {
         value = yamlTree.getChildValue(EDITOR_OPTION_KEY, option)
                                .trim().toLowerCase();
      }
      
      if (!value.isEmpty())
      {
         // there are lots of ways to say "true" in YAML...
         return YamlTree.isTrue(value);
      }
      return defaultValue;
   }
   
   public static String getString(String yaml, String option,
         String defaultValue)
   {
      YamlTree yamlTree = new YamlTree(yaml);
      
      String value = yamlTree.getChildValue(EDITOR_OPTION_KEY_V2, option);
      if (!value.isEmpty())
         return value;
      
      value = yamlTree.getChildValue(EDITOR_OPTION_KEY, option);
      if (value.isEmpty())
         return defaultValue;
      return value;
   }
   
   public static String getMarkdownOption(String yaml, String option)
   {
      YamlTree yamlTree = new YamlTree(yaml);
      String value = yamlTree.getGrandchildValue(EDITOR_OPTION_KEY_V2, MARKDOWN_OPTION_KEY, option);
      if (!value.isEmpty())
         return value;
         
      return yamlTree.getGrandchildValue(EDITOR_OPTION_KEY, MARKDOWN_OPTION_KEY, option)
                      .trim().toLowerCase();
   }
   
   public static String setMarkdownOption(String yaml, String option, String value, boolean quarto)
   {
      String key = quarto ? EDITOR_OPTION_KEY_V2 : EDITOR_OPTION_KEY ;
      YamlTree yamlTree = new YamlTree(yaml);
      
      // add editor option key if not yet present
      if (!yamlTree.containsKey(key))
         yamlTree.addYamlValue(null, key, "");
      
      // add markdown option key if not yet present
      if (!yamlTree.getChildKeys(key).contains(MARKDOWN_OPTION_KEY))
         yamlTree.addYamlValue(key, MARKDOWN_OPTION_KEY, "");
        
         
      // set value
      yamlTree.setGrandchildValue(key, MARKDOWN_OPTION_KEY, MARKDOWN_WRAP_OPTION, value);
      
      // return tree
      return yamlTree.toString();
   }
   
   public static String set(String yaml, String option, String value, boolean quarto)
   {
      String key = quarto ? EDITOR_OPTION_KEY_V2 : EDITOR_OPTION_KEY ;
      YamlTree yamlTree = new YamlTree(yaml);

      // add editor option key if not yet present
      if (!yamlTree.containsKey(key))
         yamlTree.addYamlValue(null, key, "");
      
      // add new value to the key
      yamlTree.addYamlValue(key, option, value);

      return yamlTree.toString();
   }
   
   private static String EDITOR_OPTION_KEY = "editor_options";
   private static String EDITOR_OPTION_KEY_V2 = "editor";
   private static String MARKDOWN_OPTION_KEY = "markdown";
   
   public static String MARKDOWN_WRAP_OPTION = "wrap";
   
   public static String PREVIEW_IN        = "preview";
   public static String PREVIEW_IN_WINDOW = "window";
   public static String PREVIEW_IN_VIEWER = "viewer";
   public static String PREVIEW_IN_NONE   = "none";
}
