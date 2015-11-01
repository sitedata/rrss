// rtable_gdrive.js, -*- mode: javascript; fill-column: 100; -*-
//
// This software is distributed under the terms of the BSD License.
// Copyright (c) 2015, Peter Marinov and Contributors
// see LICENSE.txt, CONTRIBUTORS.txt

//
// Use Google Drive as a cloud store
// Implementation of an interface for accessing remote tables (RTable)
//

// Declare empty namespace if not yet defined
if (typeof feeds_ns === 'undefined')
{
  feeds_ns = {};
}

(function ()
{

"use strict";

var g_documentName = 'rtables.rrss';
var g_authenticated = false;
var g_cbRecordsChanged = null;

// object RTableGDrive.p_recordsChanged
// Invoked to handle all operations that signal changes on records
// (deletion, insertion or value changes)
function p_recordsChanged(tableId, isDeleted, isLocal, key, newValue)
{
  try  // GDrive swallows all errors, install my own catchers for displahy of my own errors
  {
    var self = this;

    if (newValue == null)  // Deleting a record is equivalent of setting it to null
    {
      log.info('rtable: ' + key + ' was deleted')
      isDeleted = true;
    }
    var rtable = self.m_tables[tableId];
    var objList = [];
    var updatedObj =
            {
              id: key, // Property of this record
              isLocal: isLocal,  // Feeedback from locally initiated operation
              isDeleted: isDeleted,  // The record was deletd, data is null
              data: null
            };
    if (newValue != null)
      updatedObj.data = utils_ns.copyFields(newValue, [])  // record data
    else
      updatedObj.data = {};  // We still need a object even of only to convey the field that is the key
    updatedObj.data[rtable.key] = key;  // Add the key_name:key_valye as a field
    objList.push(updatedObj);
    g_cbRecordsChanged(tableId, objList);
  }
  catch (e)  // Error in my code, display it, then re-throw
  {
    log.error('Ooops!');
    var errorObj =
    {
      stack: e.stack
    };
    window.onerror(e.message, 'chrome-extension:mumbojumbo/app.html', 0, 0, errorObj);
    throw e;
  }
}
RTablesGDrive.prototype.p_recordsChanged = p_recordsChanged;

// object RTableGDrive.p_loadRTFile
function p_loadRTFile(rtFileID, cbDone)
{
  var self = this;

  // 1: Load rtDocument
  // 2: Define/Load the real-time data model
  gapi.drive.realtime.load(rtFileID,
      function (rtDocument) // onFileLoaded
      {
        try  // GDrive swallows all errors, install my own catchers for display of my own errors
        {
          log.info('onFileLoaded for ' + g_documentName);

          var i = 0;
          var rtModel = rtDocument.getModel();
          log.info('rtable: bytes used ' + rtModel.bytesUsed);

          for (i = 0; i < self.m_tables.length; ++i)
          {
            (function ()  // closure for rtable
            {
              // Create a map
              var tableId = i;
              var rtable = self.m_tables[i];
              rtable.map = rtModel.getRoot().get(rtable.name);
              log.info('rtable: table ' + rtable.name + ': ' +
                       rtable.map.size + ' records');

              // Attach listeners
              rtable.map.addEventListener(gapi.drive.realtime.EventType.VALUES_ADDED,
                  function (event)
                  {
                      self.p_recordsChanged(tableId, false, event.isLocal, event.property, event.newValue);
                      console.trace('rtable: ' + rtable.name + ', event: added ' + event.values);
                  });
              rtable.map.addEventListener(gapi.drive.realtime.EventType.VALUE_CHANGED,
                  function (event)
                  {
                      self.p_recordsChanged(tableId, false, event.isLocal, event.property, event.newValue);
                      console.trace('rtable: ' + rtable.name + ', event: changed ' + event.values);
                  });
              rtable.map.addEventListener(gapi.drive.realtime.EventType.VALUES_SET,
                  function (event)
                  {
                      self.p_recordsChanged(tableId, false, event.isLocal, event.property, event.newValue);
                      console.trace('rtable: ' + rtable.name + ', event: set ' + event.values);
                  });
              rtable.map.addEventListener(gapi.drive.realtime.EventType.VALUES_REMOVED,
                  function (event)
                  {
                      self.p_recordsChanged(tableId, true, event.isLocal, event.property, event.newValue);
                      console.trace('rtable: ' + rtable.name + ', event: removed ' + event.values);
                  });
            })();
          }
          cbDone(1);
        }
        catch (e)  // Error in my code, display it, then re-throw
        {
          log.error('Ooops!');
          var errorObj =
          {
            stack: e.stack
          };
          window.onerror(e.message, 'chrome-extension:mumbojumbo/app.html', 0, 0, errorObj);
          throw e;
        }
      },
      function (rtModel) // initializerFn
      {
        try  // GDrive swallows all errors, install my own catchers for display of my own errors
        {
          log.info('initializerFn for ' + g_documentName);

          // Create the data model
          var i = 0;
          var rtMap = null;
          var root = rtModel.getRoot();

          for (i = 0; i < self.m_tables.length; ++i)
          {
            rtMap = rtModel.createMap();
            root.set(self.m_tables[i].name, rtMap);
            self.m_tables[i].map = rtMap;
          }
          cbDone(2);
        }
        catch (e)  // Error in my code, display it, then re-throw
        {
          log.error('Ooops!');
          var errorObj =
          {
            stack: e.stack
          };
          window.onerror(e.message, 'chrome-extension:mumbojumbo/app.html', 0, 0, errorObj);
          throw e;
        }
      },
      function (rtError) // errorFn
      {
        try  // GDrive swallows all errors, install my own catchers for display of my own errors
        {
          log.info('errorFn ' + rtError +  'for ' +  + g_documentName);
          cbDone(0);
        }
        catch (e)  // Error in my code, display it, then re-throw
        {
          log.error('Ooops!');
          var errorObj =
          {
            stack: e.stack
          };
          window.onerror(e.message, 'chrome-extension:mumbojumbo/app.html', 0, 0, errorObj);
          throw e;
        }
      });
}
RTablesGDrive.prototype.p_loadRTFile = p_loadRTFile;

// object RTableGDrive.p_createAndLoadRTFile
function p_createAndLoadRTFile(cbDone)
{
  var self = this;

  var resource =
  {
    'resource':
    {
      mimeType: 'application/vnd.google-apps.drive-sdk',
      description: 'rtabler.rrss',
      title: g_documentName
    }
  };

  // 1: Create the shortcut file
  gapi.client.drive.files.insert(resource).execute(function (resp)
      {
        self.p_loadRTFile(resp.id, cbDone);
      });
}
RTablesGDrive.prototype.p_createAndLoadRTFile = p_createAndLoadRTFile;

// object RTablesGDrive.RTableGDrive [constructor]
function RTablesGDrive(rtables, cbDone)
{
  var self = this;

  self.m_tables = rtables;

  // Find the short-cut file for the real-time document
  var query = 'title=' + "'" + g_documentName + "'" + " and not trashed"
  gapi.client.drive.files.list(
        {
          'q': query
        }).execute(function (results)
        {
          if (results.items !== undefined && results.items.length > 0)
          {
            // Load the short-cut file
            log.info('RTableGDrive: Opening ' + g_documentName + '...')
            self.p_loadRTFile(results.items[0].id, cbDone);
            if (results.items.length > 1)
              log.warning('RTableGDrive: more than one short cut file for ' + g_documentName);
          }
          else
          {
            // Create the short-cut file and then load
            log.info('RTableGDrive: ' + g_documentName + ' is new')
            self.p_createAndLoadRTFile(cbDone);
          }
        });

  return self;
}
RTablesGDrive.prototype.p_createAndLoadRTFile = p_createAndLoadRTFile;

// object RTableGDrive.insert
// Records an entry into the remote table
function insert(tableID, entry)
{
  var self = this;

  utils_ns.assert(tableID < self.m_tables.length, 'RTableGDrive: "tableId" out of range');
  utils_ns.assert(tableID >= 0, 'RTableGDrive: "tableId" is negative');
  var rtable = self.m_tables[tableID].map;

  // Avoid data duplication as both remote ID and key as fields contents are the same
  var keyName = self.m_tables[tableID].key; 
  var key = entry[keyName];
  var optimized = utils_ns.copyFields(entry, [ keyName ]);  // Omit keyName while copying
  rtable.set(key, optimized);  // Set/overwrite optimized value for this key
}
RTablesGDrive.prototype.insert = insert;

// object RTableGDrive.readAll
function readAll()
{
  var self = this;

  // 1. Get all keys
  // 2. Read all values, one by one, for these keys
  return null;
}
RTablesGDrive.prototype.readAll = readAll;

// object RTableGDrive.deleteAll
function deleteAll()
{
  var self = this;
}
RTablesGDrive.prototype.deleteAll = deleteAll;

// object RTableGDrive.deleteRec
function deleteRec(tableID, entryKey)
{
  var self = this;

  utils_ns.assert(tableID < self.m_tables.length, 'RTableGDrive: "tableId" out of range');
  utils_ns.assert(tableID >= 0, 'RTableGDrive: "tableId" is negative');
  var rtable = self.m_tables[tableID].map;

  var value = rtable.delete(entryKey);
  var result_str = 'OK';
  if (value == null)
    result_str = 'no existing value';
  log.info('RTableGDrive: deleting Id ' + entryKey + '...' + result_str);
}
RTablesGDrive.prototype.deleteRec = deleteRec;

// object RTableGDrive.initialSync
// local -- dictionary of keys of local entries this way initialSync()
//          can generate events for all that were deleted remotely too
// local = null, won't generate delete events
function initialSync(tableID, local)
{
  var self = this;

  utils_ns.assert(tableID < self.m_tables.length, 'RTableGDrive: "tableId" out of range');
  utils_ns.assert(tableID >= 0, 'RTableGDrive: "tableId" is negative');
  var rtable = self.m_tables[tableID].map;

  var allKeys = rtable.keys();
  log.info('initialSync: for \'' +  self.m_tables[tableID].name + '\': total number of keys ' + allKeys.length);

  var x = 0;
  var objlist = [];
  var rec = null;
  var updateObj = null;
  var key = null;
  var keyName = null;

  for (x = 0; x < allKeys.length; ++x)
  {
    // One key/value pair
    key = allKeys[x];  // Key
    rec = rtable.get(key);  // Value

    // Imitate generation of an updated obj
    updateObj =
      {
        isLocal: false,  // Feeedback from locally initiated operation
        isDeleted: false,  // The record was deletd, data is null
        data: utils_ns.copyFields(rec, [])  // record data
      };
    keyName = self.m_tables[tableID].key; 
    updateObj.data[keyName] = key;  // Add the key_name:key_valye as a field
    objlist.push(updateObj);

    if (local == null)
      continue;

    if (local[key] === undefined)
      continue;

    local[key] = 1;
  }
  g_cbRecordsChanged(tableID, objlist);

  if (local == null)
    return;

  // Generate event _deleted_ for all that were in local but
  // not in the remote table
  var keys = Object.keys(local);
  objlist = [];
  for (x = 0; x < keys.length; ++x)
  {
    key = keys[x];
    if (local[key] == 1)  // In local AND in remote
      continue;

    // local[key] is only in local, needs to be deleted
    updateObj =
      {
        id: key, // Id of this record, created by Dropbox
        isLocal: false,  // Feeedback from locally initiated operation
        isDeleted: true,  // The record was deletd, data is null
        data: null  // record data, no data needed for delete operation
      };
    objlist.push(updateObj);
  }
  log.info('rtable.initialSync: ' + objlist.length + ' record(s) not in remote table that will be deleted');
  g_cbRecordsChanged(tableID, objlist);
}
RTablesGDrive.prototype.initialSync = initialSync;

// Attach one global listener to handle the datastore
function RTablesAddListener(cbRecordsChanged)
{
  g_cbRecordsChanged = cbRecordsChanged;
}

// Checks if Dropbox is still connected
function RTablesIsOnline()
{
  return g_authenticated;
}

// Call this once at init time to complete the initialization
function RTablesInit(accessToken, cbReady)
{
  gapi.load('auth:client', function()
      {
        var token =
        {
          access_token: accessToken
        }
        gapi.auth.setToken(token);
        g_authenticated = true;
        gapi.client.load('drive', 'v2', cbReady);
      });
}

feeds_ns.RTablesGDrive = RTablesGDrive;
feeds_ns.RTablesAddListener = RTablesAddListener;
feeds_ns.RTablesIsOnline = RTablesIsOnline;
feeds_ns.RTablesInit = RTablesInit;
})();