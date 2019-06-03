/*
 * Preferences.cpp
 *
 * Copyright (C) 2009-19 by RStudio, Inc.
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


#include <session/prefs/Preferences.hpp>

using namespace rstudio::core;

namespace rstudio {
namespace session {
namespace prefs {

core::json::Array Preferences::allLayers()
{
   json::Array layers;
   for (auto layer: layers_)
   {
      layers.push_back(layer->allPrefs());
   }
   return layers;
}

core::Error Preferences::readLayers()
{
   Error error;
   for (auto layer: layers_)
   {
      error = layer->readPrefs();
      if (error)
      {
         LOG_ERROR(error);
      }
   }
   return Success();
}

core::Error Preferences::initialize()
{
   Error error = createLayers();
   if (error)
      return error;

   error = readLayers();
   if (error)
      return error;

   for (auto layer: layers_)
   {
      error = layer->validatePrefs();
      if (error)
         LOG_ERROR(error);
   }

   return Success();
}

core::Error Preferences::writeLayer(size_t layer, const core::json::Object& prefs)
{
   // We cannot write the base layer or a non-existent layer.
   if (layer >= layers_.size() || layer < 1)
      return systemError(boost::system::errc::invalid_argument, ERROR_LOCATION);

   // Write only the unique values in this layer.
   json::Object unique;
   for (const auto pref: prefs)
   {
      // Check to see whether the value for this preference (a) exists in some other lower layer,
      // and if so (b) whether it differs from the value in that layer.
      bool found = false;
      bool differs = false;
      for (size_t i = layer - 1; i >= 0; --i)
      {
         auto val = layers_[i]->readValue(pref.name());
         if (val)
         {
            found = true;
            if (!(*val == pref.value()))
            {
               differs = true;
            }
            break;
         }
      }

      if (!found || differs)
      {
         // If the preference doesn't exist in any other layer, or the value doesn't match the them,
         // record the unique value in this layer.
         unique[pref.name()] = pref.value();
      }
   }

   Error result =  layers_[layer]->writePrefs(unique);
   if (result)
      return result;

   // Empty value indicates that we changed multiple prefs
   // onChanged("");
   return Success();
}

} // namespace prefs
} // namespace session
} // namespace rstudio
