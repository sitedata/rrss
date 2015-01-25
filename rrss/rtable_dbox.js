// rtable_dbox.js, -*- mode: javascript; -*-
//
// This software is distributed under the terms of the BSD License.
// Copyright (c) 2014, Peter Marinov and Contributors
// see LICENSE.txt, CONTRIBUTORS.txt

//
// Use Dropbox as a cloud store
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

// Handle to Dropbox's datastore
var g_datastore = null;
var g_client = null;

var g_cbRecordsChanged = null;

// Listg of all remote tables, of type:
// { table: string (name), id: integer }
var g_tables = [];

// object RTableDBox.RTableDBox [constructor]
// Used for access of remote table stored in Dropbox
// _fields_ is the list of all fields of objects inserted in the table
// _key_ name of primary key, used as Dropbox ID
// Set _key_ to '' to activate automatically generated IDs by Dropbox
function RTableDBox(name, fields, key)
{
  var self = this;

  utils_ns.assert(g_datastore != null, 'RTableDBox: g_datastore is null');
  self.m_table = g_datastore.getTable(name);
  self.m_tableId = self.m_table.getId();
  self.m_fields = fields;
  self.m_key = key;

  g_tables.push(self);

  // Record status for listeners
  self.RECORD_UPDATED = 1;
  self.RECORD_DELETED = 2;
  self.RECORD_LOCAL = 3;  // feedback from local RTable.insert/delete actions

  return self;
}

// object RTableDBox.insert
// Records an entry into the remote table
// Updates if remoteId != ''
// Inserts if remoteId == '', returns remoteId of the new record
function insert(entry, remoteId)
{
  var self = this;
  var rec = null;
  var key = null;
  var optimized = null;

  if (remoteId == '')  // No remoteID, then operation insert()
  {
    if (self.m_key != '')  // Use own field as a primary key
    {
      key = entry[self.m_key];
      // Avoid data duplication as both remote ID and key as fields contents are the same
      optimized = utils_ns.copyFields(entry, [ self.m_key ]);
      rec = self.m_table.getOrInsert(entry[self.m_key], optimized);
    }
    else  // Use automatically generated keys by Dropbox
    {
      rec = self.m_table.insert(entry);
    }
    remoteId = rec.getId();
    log.info('rtable: inserted new ' + remoteId);
  }
  else  // Record already exists, has remote ID, then operation update()
  {
    rec = self.m_table.get(remoteId);
    if (rec == null)
    {
      // This is probably not needed
      // During development there can be discrepancy between local DB and remote DB
      // Fallback to insert and return new remoteId
      log.info('rtable: fall back onto insert for ' + remoteId);
      remoteId = self.insert(entry, remoteId);
    }
    else
    {
      if (self.m_key != '')
      {
        optimized = utils_ns.copyFields(entry, [ self.m_key ]);
        rec.update(optimized);
      }
      else
        rec.update(entry);
      log.info('rtable: updated ' + remoteId);
    }
  }

  return remoteId;
}
RTableDBox.prototype.insert = insert;


// object RTableDBox.readAll
function readAll()
{
  var self = this;

  return self.m_table.query();
}
RTableDBox.prototype.readAll = readAll;

// object RTableDBox.deleteAll
function deleteAll()
{
  var self = this;

  var i = 0;
  var recID = null;

  var entries = self.m_table.query();

  for (i = 0; i < entries.length; ++i)
  {
    recID = entries[i].getId();
    if (entries[i].isDeleted())
    {
      log.info('rtable: already deleted Id ' + recID + ', done.')
    }
    else
    {
      log.info('rtable: deleting Id ' + recID + '...')
      entries[i].deleteRecord();
    }
  }
}
RTableDBox.prototype.deleteAll = deleteAll;

// object RTableDBox.deleteRec
function deleteRec(entryKey)
{
  var self = this;
  var entry = self.m_table.get(entryKey);
  if (entry.isDeleted())
  {
      log.info('rtable: already deleted Id ' + recID + ', done.')
  }
  entry.deleteRecord();
  log.info('rtable: deleting Id ' + entryKey + '...')
}
RTableDBox.prototype.deleteRec = deleteRec;

// object RTableDBox.p_copyObj
// Converts from Datastore object into rtable record object
// This means to copy all the fields listed in m_fields + m_key
function p_copyObj(dboxObj)
{
  var self = this;

  var p = 0;
  var key = 0;
  var r = new Object();
  for (p = 0; p < self.m_fields.length; ++p)
  {
    key = self.m_fields[p];
    if (key == self.m_key)
      r[key] = dboxObj.getId();  // Key is also an ID
    else
      r[key] = dboxObj.get(key);  // Dropbox.Datastore.Record.get()
  }

  return r;
}
RTableDBox.prototype.p_copyObj = p_copyObj;

// object RTableDBox.initialSync
// local -- dictionary of keys of local entries this way initialSync()
//          can generate events for all that were deleted remotely too
// local = null, won't generate delete events
function initialSync(local)
{
  var self = this;

  var x = 0;
  var dboxRecs = self.m_table.query();
  var objlist = [];
  var rec = null;
  var updateObj = null;
  for (x = 0; x < dboxRecs.length; ++x)
  {
    rec = dboxRecs[x];
    // Imitate generation of an updated obj
    updateObj =
      {
        id: rec.getId(), // Id of this record, created by Dropbox
        isLocal: false,  // Feeedback from locally initiated operation
        isDeleted: false,  // The record was deletd, data is null
        data: self.p_copyObj(rec)  // record data (based on m_fields)
      };
    objlist.push(updateObj);

    if (local == null)
      continue;

    if (local[rec.getId()] === undefined)
      continue;

    local[rec.getId()] = 1;
  }
  g_cbRecordsChanged(self.m_tableId, objlist);

  if (local == null)
    return;

  // Generate event _deleted_ for all that were in local but
  // not in the remote table
  var keys = Object.keys(local);
  var key = null;
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
  g_cbRecordsChanged(self.m_tableId, objlist);
}
RTableDBox.prototype.initialSync = initialSync;

// Invoke registered listeners once per remote table to notify of changed records
function recordsChanged(dstoreEvent)
{
  var i = 0;
  var k = 0;
  var p = 0;
  var rec = null;
  var fields = null;
  var key = null;
  var records = null;
  var objlist = []
  var isLocal = false;
  var updatedObj = null;
  // For each table call to notify for changed records
  for (i = 0; i < g_tables.length; ++i)
  {
    // Dropbox doesn't give us a row from the table, it gives us a record
    // which can the be used for inquiring what exactly is this event and
    // also to access the data by calls to record.get('m_field')
    records = dstoreEvent.affectedRecordsForTable(g_tables[i].m_tableId);
    isLocal = dstoreEvent.isLocal();
    fields = g_tables[i].m_fields;

    // Now for this record, by using the known list of fields, produce
    // an object
    for (k = 0; k < records.length; ++k)
    {
      updatedObj =
          {
            id: null, // Id of this record, created by Dropbox
            isLocal: false,  // Feeedback from locally initiated operation
            isDeleted: false,  // The record was deletd, data is null
            data: null  // record data (based on m_fields)
          };
      rec = records[k];
      updatedObj.id = rec.getId();
      updatedObj.data = null;
      if (isLocal)
      {
        log.info('rtable: listener: ' + rec.getId() + ' locally initiated update.');
        updatedObj.isLocal = true;
      }
      if (rec.isDeleted())
      {
        updatedObj.isDeleted = true;
        log.info('rtable: listener: ' + rec.getId() + ' was deleted.');
      }
      else
      {
        if (!isLocal)
          log.info('rtable: listener: ' + rec.getId() + ' was updated remotedly.');
        updatedObj.data = new Object();
        for (p = 0; p < fields.length; ++p)
        {
          key = fields[p];
          if (key == g_tables[i].m_key)
            updatedObj.data[key] = rec.getId();  // Key is also an ID
          else
            updatedObj.data[key] = rec.get(key);  // Dropbox.Datastore.Record.get()
        }
      }
      objlist.push(updatedObj);
    }

    if (g_cbRecordsChanged == null)
    {
      log.warning('rtable: unhandled event');
      return;
    }

    g_cbRecordsChanged(g_tables[i].m_tableId, objlist);
    objlist = [];
  }
}

// Attach one global listener to handle the datastore
function RTableAddListener(cbRecordsChanged)
{
  g_cbRecordsChanged = cbRecordsChanged;
}

// Checks if Dropbox is still connected
function RTableIsOnline()
{
  if (g_client == null)
    return false;
  else
    return g_client.isAuthenticated();
}

// Call this once at init time to complete the initialization
function RTableInit(dboxClient, cbReady)
{
  g_client = dboxClient;
  var datastoreManager = g_client.getDatastoreManager();
  datastoreManager.openDefaultDatastore(function (error, datastore)
      {
        if (error)
        {
            alert('Error opening default datastore: ' + error);
            cbReady(1);
        }
        else
        {
            g_datastore = datastore;
            g_datastore.recordsChanged.addListener(recordsChanged);
            cbReady(0);
        }
      });
}

feeds_ns.RTableDBox = RTableDBox;
feeds_ns.RTableAddListener = RTableAddListener;
feeds_ns.RTableIsOnline = RTableIsOnline;
feeds_ns.RTableInit = RTableInit;
})();
