// feeds.js, -*- mode: javascript; -*-
//
// This software is distributed under the terms of the BSD License.
// Copyright (c) 2014, Peter Marinov and Contributors
// see LICENSE.txt, CONTRIBUTORS.txt

//
// Local database management of RSS feeds
// Polling loop for fetching fresh RSS data
//

// Declare empty namespace if not yet defined
if (typeof feeds_ns === 'undefined')
  feeds_ns = {};

(function ()
{
"use strict";

// object Feeds.Feeds [constructor]
// Instantiate one per application
function Feeds(feedsCB)
{
  var self = this;

  self.m_feedsCB = feedsCB;  // call-backs

  self.m_rssFeeds = [];  // array of RssHeader, sorted by url
  self.m_listNotify = [];

  // Poll loop
  self.m_pollIndex = 0;
  self.m_timeoutID = null;

  self.m_db = null;
  self.m_rss_entry_cnt = 0;

  self.p_dbOpen();

  // Set to true if Dropbox status is logged in
  self.m_remote_is_connected = false;

  // Subscribed RSS feeds stored in Dropbox (RTableDBox)
  self.m_remote_subscriptions = null;

  // RSS entries that are marked as read stored in Dropbox
  // (RTableDBox)
  self.m_remote_read = null;

  // Start the poll loop
  self.m_timeoutID = setTimeout(p_poll, 1, self);

  return this;
}

// object RemoteEntryRead [constructor]
// From an RssEntry constructs a RemoteEntryRead record
function RemoteEntryRead(rssEntry)
{
  this.m_rss_entry_hash = null;
  this.m_rss_feed_hash = null;
  this.m_is_read = false;
  this.m_date = null;
  if (rssEntry == null)  // An empty object was requested?
    return this;

  this.m_rss_entry_hash = rssEntry.m_hash;

  var h = rssEntry.m_rssurl_date.indexOf('_');
  utils_ns.assert(h >= 0, "RemoteEntryRead: invalid rssurl_date hash");
   var rssurl_hash = rssEntry.m_rssurl_date.slice(0, h);
  this.m_rss_feed_hash = rssurl_hash;

  this.m_is_read = rssEntry.m_is_read;
  this.m_date = utils_ns.dateToStrStrict(rssEntry.m_date);
  return this;
}

// object RemoteFeedUrl [constructor]
// From an RssHeader constructs a RemoteFeedUrl record
function RemoteFeedUrl(feed)
{
  this.m_rss_feed_hash = null;  // this is a key in the remote table
  this.m_rss_feed_url = null;
  this.m_tags = null;
  if (feed == null)  // An empty object was requested?
    return this;

  this.m_rss_feed_hash = feed.m_hash;
  this.m_rss_feed_url = feed.m_url;
  this.m_tags = feed.m_tags;
  return this;
}

// object Feeds.p_rtableListener
// Handle updates from the remote tables
function p_rtableListener(table, records)
{
  var self = this;

  // Listener for 'rss_subscriptions' not yet ready
  if (table == 'rss_subscriptions')
    return;

  var k = 0;
  var r = null;
  for (k = 0; k < records.length; ++k)
  {
    (function()  // scope
    {
      r = records[k];

      // Skip operation if it is local
      if (r.isLocal)  // our own loop-back?
        return;  // leave the anonymous scope

      // Skip operation if it is remote delete
      // Local delete will take place when scheduled
      if (r.isDeleted)  // remotely deleted?
        return;  // leave the anonymous scope

      // Reflect the new state on the screen (if the feed is currently displayed)
      self.m_feedsCB.onRemoteMarkAsRead(r.data.m_rss_entry_hash, r.data.m_rss_feed_hash, r.data.m_is_read);

      // Apply new state in the IndexedDB
      var rss_entry_hash = r.data.m_rss_entry_hash;
      var is_read = r.data.m_is_read;
      self.feedUpdateEntry(rss_entry_hash,
          function(state, dbEntry)
          {
            if (state == 0)
            {
              utils_ns.assert(dbEntry.m_hash == rss_entry_hash, 'markAsRead: bad data');

              if (dbEntry.m_is_read == is_read)  // Nothing changed?
              {
                log.info('db: update entry (' + rss_entry_hash + '): is_read = ' + is_read);
                return 1;  // Don't record in the DB
              }
              else
              {
                dbEntry.m_is_read = is_read;
                dbEntry.m_remote_state = feeds_ns.RssSyncState.IS_SYNCED
                return 0;  // Record in the DB
              }
            }
            else if (state == 1)
            {
              log.info('db: update entry (' + rss_entry_hash + '): not found: put local placeholder');
              dbEntry.m_remote_state = feeds_ns.RssSyncState.IS_REMOTE_ONLY;
              // TODO: when entry is fetched by the RSS loop, take care to respect IS_REMOTE_ONLY
              // TODO: don't overwrite the m_is_read flag
              dbEntry.m_is_read = is_read;
              return 0;
            }
          });
    })()
  }
}
Feeds.prototype.p_rtableListener = p_rtableListener;

// object Feeds.p_rtableSyncEntry
// Sync one RSS entry with the remote table
function p_rtableSyncEntry(rssEntry)
{
  var self = this;

  var remoteEntry = null;
  var remoteId = null;

  if (feeds_ns.RTableIsOnline())
  {
    remoteEntry = new RemoteEntryRead(rssEntry);
    remoteId = self.m_remote_read.insert(remoteEntry, rssEntry.m_remote_id);
    rssEntry.m_remote_state = feeds_ns.RssSyncState.IS_SYNCED;
    rssEntry.m_remote_id = remoteId;
    log.trace('rtableSyncEntry: remote OK (' + rssEntry.m_hash + ')');
  }
  else
  {
    // Data can't be sent, mark it for sending at the next opportunity
    rssEntry.m_remote_state = feeds_ns.RssSyncState.IS_PENDING_SYNC;
    log.info('rtableSyncEntry: local only (' + rssEntry.m_hash + ' -> IS_PENDING_SYNC)');
  }
}
Feeds.prototype.p_rtableSyncEntry = p_rtableSyncEntry;

// object Feeds.p_rtableSyncFeedEntry
// Sync one RSS feed (RSSHeader) entry with the remote table
function p_rtableSyncFeedEntry(feed)
{
  var self = this;

  var remoteFeed = null;
  var remoteId = null;

  if (feeds_ns.RTableIsOnline())
  {
    remoteFeed = new RemoteFeedUrl(feed);
    remoteId = self.m_remote_subscriptions.insert(remoteFeed, feed.m_remote_id);
    feed.m_remote_state = feeds_ns.RssSyncState.IS_SYNCED;
    feed.m_remote_id = remoteId;
    log.trace('p_rtableSyncFeedEntry: remote OK (' + remoteFeed.m_rss_feed_url + ')');
  }
  else
  {
    // Data can't be sent, mark it for sending at the next opportunity
    rssEntry.m_remote_state = feeds_ns.RssSyncState.IS_PENDING_SYNC;
    log.info('p_rtableSyncFeedEntry: local only (' + remoteFeed.m_rss_feed_url + ' -> IS_PENDING_SYNC)');
  }
}
Feeds.prototype.p_rtableSyncFeedEntry = p_rtableSyncFeedEntry;

// object Feeds.p_rtableSyncStatusRead
// Walk over all RSS entry records in the local DB and send to
// remote table:
// 1. all that were marked as read (feeds_ns.RssSyncState.IS_LOCAL_ONLY)
// 2. all that were marked as feeds_ns.RssSyncState.IS_PENDING_SYNC
// NOTE: By not sending is_read = false && IS_LOCAC_ONLY we
// temporarely save a bit of space on the remote DB
function p_rtableSyncStatusRead()
{
  var self = this;

  self.updateEntriesAll(
      function(rssEntry)
      {
        if (rssEntry == null)  // No more entries
          return 0;

        if (rssEntry.m_remote_state == feeds_ns.RssSyncState.IS_LOCAL_ONLY)
        {
          // Record all read entries in the remote table
          if (rssEntry.m_is_read)
          {
            log.info('rtableSyncStatusRead: complete pending operation (' + rssEntry.m_hash + ')');
            self.p_rtableSyncEntry(rssEntry);
            return 1;  // Update entry
          }
        }

        if (rssEntry.m_remote_state == feeds_ns.RssSyncState.IS_PENDING_SYNC)
        {
          // Record all read entries in the remote table
          log.info('rtableSyncStatusRead: mark as pending operation (' + rssEntry.m_hash + ')');
          self.p_rtableSyncEntry(rssEntry);
          return 1;  // Update entry
        }

        return 2;  // No changes to the entry, move to the next
      });
}
Feeds.prototype.p_rtableSyncStatusRead = p_rtableSyncStatusRead;

// object Feeds.p_rtableSyncRemoteSubscriptions
// Walk over all RSS feed records in the local DB and send to
// remote table if m_remote_status is feeds_ns.RssSyncState.IS_LOCAL_ONLY)
function p_rtableSyncRemoteSubscriptions()
{
  var self = this;

  self.p_feedsUpdateAll(
      function(feed)
      {
        if (feed == null)  // No more entries
          return 0;

        if (feed.m_remote_state == feeds_ns.RssSyncState.IS_LOCAL_ONLY)
        {
          // Record all read entries in the remote table
          log.info('p_rtableSyncRemoteSubscriptions: complete pending operation (' + feed.m_url + ')');
          self.p_rtableSyncFeedEntry(feed);
          return 1;  // Update entry
        }

        if (feed.m_remote_state == feeds_ns.RssSyncState.IS_PENDING_SYNC)
        {
          // Record all read entries in the remote table
          log.info('p_rtableSyncRemoteSubscriptions: mark as pending operation (' + feed.m_url + ')');
          self.p_rtableSyncFeedEntry(feed);
          return 1;  // Update entry
        }

        return 2;  // No changes to the entry, move to the next
      });
}
Feeds.prototype.p_rtableSyncRemoteSubscriptions = p_rtableSyncRemoteSubscriptions;

// object Feeds.p_rtableInitRemoteEntryRead
// Initialize remote table (rtable) that stores status_read for RSS entries
function p_rtableInitRemoteEntryRead()
{
  var self = this;

  // To obtain the list of fields:
  // 1. A new empty RemoteEntryRead
  // 2. Enumerate fields that start with 'm_'
  var dummy = new RemoteEntryRead(null);
  var fields = utils_ns.listOfFields(dummy, 'm_');

  self.m_remote_read = new feeds_ns.RTableDBox('rss_entries_read', fields, 'm_rss_entry_hash');
  // NOTE: !!! one listener handles all tables !!!
  feeds_ns.RTableAddListener(
      function (table, records)
      {
        self.p_rtableListener(table, records);
      });

  // There are two ways for getting data from Dropbox's datastore
  // 1. Listen to events: these changes are reflected into the local
  //    indexed db.
  // 2. Do a query for an individual entry. Feeds objec never does #2,
  //    it relies exclusively on faithfully mirroring the events.
  //
  // At startup time, Dropbox's datastore brings all entries that were
  // updated remotely but doesn't generate corresponding
  // events. Unfortunately, we have to do a full datastore query that
  // walks all entries only to discover what changed remotely.
  self.m_remote_read.initialSync();

  // Walk over all RSS entry records in the local DB and send to
  // remote table all that were marked as read
  self.p_rtableSyncStatusRead();
}
Feeds.prototype.p_rtableInitRemoteEntryRead = p_rtableInitRemoteEntryRead;

// object Feeds.p_rtableInitRemoteFeedUrl
// Initialize remote table (rtable) that stores url of RSS feeds
function p_rtableInitRemoteFeedUrl()
{
  var self = this;

  var dummy = new RemoteFeedUrl(null);
  var fields = utils_ns.listOfFields(dummy, 'm_');

  self.m_remote_subscriptions = new feeds_ns.RTableDBox('rss_subscriptions', fields, 'm_rss_feed_hash');

  self.m_remote_subscriptions.initialSync();
  self.p_rtableSyncRemoteSubscriptions();
}
Feeds.prototype.p_rtableInitRemoteFeedUrl = p_rtableInitRemoteFeedUrl;

// object Feeds.rtableConnect
// This method is invoked once when the application is logged into Dropbox
function rtableConnect()
{
  var self = this;

  log.info('rtableConnect()...');

  self.m_remote_is_connected = true;

  self.p_rtableInitRemoteEntryRead();
  self.p_rtableInitRemoteFeedUrl();

  log.info('rtableConnect(), done.');
}
Feeds.prototype.rtableConnect = rtableConnect;

// object Feeds.rtableDisconnect
// This method is invoked once when the application is logged out from Dropbox
function rtableDisconnect()
{
  self.m_remote_is_connected = false;
}
Feeds.prototype.rtableDisconnect = rtableDisconnect;

// object Feeds.p_feedReadAll
// Load list of feeds (RssHeaders) from IndexedDB
// Delete permanently feeds marked as x_is_unsubscribed
function p_feedReadAll()
{
  var self = this;
  var listToRemove = [];

  // Read the list of RSS subscriptions from IndexDB
  var cnt = 0;
  var tran = self.m_db.transaction('rss_subscriptions', 'readonly');
  tran.oncomplete = function (event)
      {
        log.info('db: transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: transaction error');
      };
  var s = tran.objectStore('rss_subscriptions');
  var c = s.openCursor();
  c.onerror = function (event)
      {
        log.error('db: cursor error');
      };
  c.onsuccess = function(event)
      {
        var cursor = event.target.result;
        if (!cursor)
        {
          console.log('db: ' + cnt + ' subscriptions retrieved');
          self.p_feedRemoveList(listToRemove);
          self.m_feedsCB.onDbInitDone();
          return;  // no more entries
        }
        var hdr = cursor.value;
        if (hdr.m_is_unsubscribed)
          listToRemove.push(feeds_ns.copyRssHeader(hdr));
        else
          self.p_feedAdd(feeds_ns.copyRssHeader(hdr), null);
        ++cnt;
        cursor.continue();
      };
}
Feeds.prototype.p_feedReadAll = p_feedReadAll;

// object Feeds.p_dbOpen
// This completes the initialization of the Feeds object
function p_dbOpen()
{
  var self = this;

  log.info('db: connect to Feeds database...');
  var req = window.indexedDB.open('rrss', 1);
  req.onerror = function (event)
      {
        // Global error handler for all database errors
        // TODO: formulate a message and pass this to callback for display outside Feeds
        log.error('db: error: ' + req.errorCode);
        alert('db: error, check Console');
      };
  req.onblocked = function (event)
      {
        log.error("db: Feeds database is still in use by another instance");
      }
  req.onsuccess = function (event)
      {
        log.info("db: Feeds database already exists");
        var db = req.result;
        log.info(db.objectStoreNames);

        self.m_db = db;
        self.p_feedReadAll();
      };
  req.onupgradeneeded = function(event)
      {
        log.info('db: first time, create tables of Feeds DB...');
        var db = event.target.result;

        // Records of type RssHeader 
        var s = db.createObjectStore('rss_subscriptions', { keyPath: 'm_url' });
        log.info('db: table "rss_subscriptions" created');

        s.createIndex('remote_id', 'm_remote_id', { unique: false });
        log.info('db: index "remote_id" created');

        // Records of type RssEntry
        var d = db.createObjectStore('rss_data', { keyPath: 'm_hash' });
        log.info('db: table "rss_data" created');

        d.createIndex('rssurl_date', 'm_rssurl_date', { unique: false });
        log.info('db: index "rssurl_date" created');

        d.createIndex('remote_id', 'm_remote_id', { unique: false });
        log.info('db: index "remote_id" created');

        // Records of pref=value: store user preferences as k/v pairs
        var d = db.createObjectStore('preferences', { keyPath: 'm_pref' });
        log.info('db: table "preferences" created');

        self.m_db = db;
        log.info('db: tables and indexes of Feeds DB created');

        self.m_feedsCB.onDbCreated();

        // TODO: we get an error here: Failed to execute 'transaction'
        // on 'IDBDatabase': A version change transaction is running.
        // Q: But how we'll re-read any old data when we upgrade tables?!
        // self.p_feedReadAll();  // From any previous version of the db
      };
}
Feeds.prototype.p_dbOpen = p_dbOpen;

// function compareRssHeadersByUrl
// for binarySearch()
function compareRssHeadersByUrl(feed1, feed2)
{
  if (feed1.m_url > feed2.m_url)
    return 1;
  if (feed1.m_url < feed2.m_url)
    return -1;
  return 0;
}

// object Feeds.p_feedAdd
// add a feed (RSSHeader) to list of feeds, start the fetch pump loop
function p_feedAdd(newFeed, cbDone)
{
  var self = this;

  // Find insertion point into the sorted m_rssFeeds[]
  var m = self.m_rssFeeds.binarySearch(newFeed, compareRssHeadersByUrl);
  if (m >= 0)  // Entry with this url is already in
    return;

  m = -(m + 1);
  if (m >= self.m_rssFeeds.length)  // add?
    self.m_rssFeeds.push(newFeed);
  else  // insert
    self.m_rssFeeds.splice(m, 0, newFeed);

  // Notify event subscribers
  var listNewFeeds = new Array();
  listNewFeeds.push(newFeed);
  self.m_feedsCB.onRssUpdated(listNewFeeds);

  // Fetch the RSS data for this URL, update the subscribed listeners
  self.p_fetchRss(newFeed.m_url, null,
      function()  // CB: write operation is completed
      {
        if (cbDone != null)
          cbDone();
      });
}
Feeds.prototype.p_feedAdd = p_feedAdd;

// object Feeds.p_feedRecord
// Insert a new record or update a record of a feed (RssHeader) in the indexedDB
function p_feedRecord(feed)
{
  var self = this;
  // operate on the copy, not on the reference
  var feed2 = feeds_ns.copyRssHeader(feed);

  // Insert entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_subscriptions'], 'readwrite');
  tran.oncomplete = function (event)
      {
        log.info('db: write transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: write transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: write transaction error');
      };
  var store = tran.objectStore('rss_subscriptions');
  var req = store.get(feed2.m_url);
  req.onsuccess = function(event)
      {
        var needsUpdate = false;
        var data = req.result;
        if (data === undefined)
          needsUpdate = true;  // entry is not in the DB
        else
        {
          // Check if the record in the DB needs updating
          log.info('db: entry already in [' + feed2.m_url + ']');
          if (feed2.m_title != data.m_title)
          {
            console.log('db: new title: ' + feed2.m_title + ' (old: ' + data.m_title + ')');
            needsUpdate = true;
          };
          if (feed2.m_link != data.m_link)
          {
            console.log('db: new link: ' + feed2.m_link + ' (old: ' + data.m_link + ')');
            needsUpdate = true;
          };
          if (feed2.m_description != data.m_description)
          {
            console.log('db: new description: ' + feed2.m_description + ' ' +
                        '(old: ' + data.m_description + ')');
            needsUpdate = true;
          };
          if (feed2.m_rss_type != data.m_rss_type)
          {
            console.log('db: new rss_type: ' + feed2.m_rss_type + ' ' +
                        '(old: ' + data.m_rss_type + ')');
            needsUpdate = true;
          };
          if (feed2.m_rss_version != data.m_rss_version)
          {
            console.log('db: new rss_version: ' + feed2.m_rss_version + ' ' +
                        '(old: ' + data.m_rss_version + ')');
            needsUpdate = true;
          };
          if (feed2.m_tags != data.m_tags)
          {
            console.log('db: new tags: ' + feed2.m_tags + ' ' +
                        '(old: ' + data.m_tags + ')');
            needsUpdate = true;
          }
          if (feed2.m_is_unsubscribed != data.m_is_unsubscribed)
          {
            console.log('db: new is_unsubscribed: ' + feed2.m_is_unsubscribed + ' ' +
                        '(old: ' + data.m_is_unsubscribed + ')');
            needsUpdate = true;
          }
        };
        if (needsUpdate)
        {
          var reqAdd = store.put(utils_ns.marshal(feed2, 'm_'));
          reqAdd.onsuccess = function(event)
              {
                var data = reqAdd.result;
                log.info('db: added! [' + feed2.m_url + ']');
              }
          reqAdd.onerror = function(event)
              {
                log.error('db: error msg: ' + reqAdd.error.message);
              }
        }
      }
}
Feeds.prototype.p_feedRecord = p_feedRecord;

// object Feeds.feedAddByUrl
// add a new feed (by URL) to list of feeds, start the fetch pump loop (via p_feedAdd)
function feedAddByUrl(feedUrl, cbDone)
{
  var self = this;
  var newFeed = feeds_ns.emptyRssHeader();
  newFeed.m_url = feedUrl;
  newFeed.m_title = feedUrl;

  // Add to table rss_subscriptions (it will be updated when more data is fetched)
  self.p_feedRecord(newFeed);

  // Add to the resident list of feeds (will become part of the fetch loop)
  // Do first fetch of RSS
  self.p_feedAdd(newFeed,
      function()
      {
        if (cbDone != null)
          cbDone();
      });
}
Feeds.prototype.feedAddByUrl = feedAddByUrl;

// object Feeds.p_feedRemoveDB
// Deletes a feed from database table 'rss_subscriptions'
function p_feedRemoveDB(feedUrl)
{
  var self = this;

  // Find entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_subscriptions'], 'readwrite');
  tran.oncomplete = function (event)
      {
        log.info('db: delete transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: delete transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: delete transaction error');
      };
  var store = tran.objectStore('rss_subscriptions');

  // IndexedDB documentation states that direct call to
  // store.delete(key) should work. But on Google Chrome if the key is
  // invalid we still get onsuccess().
  // Workaround: confirm that the record exists first
  var req = store.get(feedUrl);
  var req2 = null;
  req.onsuccess = function(event)
      {
        var data = req.result;
        if (data === undefined)
        {
          log.error('db: delete request error, record not found for ' + feedUrl);
          return;
        }
        // Record exists, delete it
        req2 = store.delete(feedUrl);
        req2.onsuccess = function(event)
            {
              log.info('db: delete request success, feed: ' + feedUrl);

              var f = feeds_ns.emptyRssHeader();
              f.m_url = feedUrl;
              var listRemoved = [];
              listRemoved.push(f);
              self.m_feedsCB.onRssRemoved(listRemoved);
            }
        req2.onerror = function(event)
            {
              log.error('db: delete request error2 for ' + req2.result.m_url);
            }
      }
  req.onerror = function(event)
      {
        log.error('db: delete request error1 for ' + req.result.m_url);
      }
}
Feeds.prototype.p_feedRemoveDB = p_feedRemoveDB;

// object Feeds.p_feedRemoveList
// Deletes a list of feeds from database table 'rss_subscriptions'
function p_feedRemoveList(listToRemove)
{
  var self = this;

  var i = 0;
  var hdr = null;
  for (i = 0; i < listToRemove.length; ++i)
  {
    hdr = listToRemove[i];
    utils_ns.assert(hdr instanceof feeds_ns.RssHeader, "p_feedRemoveList: x instanceof feeds_ns.RssHeader");

    log.info('execute deferred remove: ' + hdr.m_url);
    self.p_feedRemoveDB(hdr.m_url);
  }
}
Feeds.prototype.p_feedRemoveList = p_feedRemoveList;

// object Feeds.feedRemove
// Deletes a feed from database table 'rss_subscriptions' and list of feeds
function feedRemove(feedUrl)
{
  var self = this;

  // Find feed in the list of feeds
  var feed = feeds_ns.emptyRssHeader();
  feed.m_url = feedUrl;
  var m = self.m_rssFeeds.binarySearch(feed, compareRssHeadersByUrl);
  if (m < 0)
  {
    log.error('rss feed ' + feedUrl + ' not found');
    return;
  }

  // Remove from list of feeds
  self.m_rssFeeds.splice(m, 1);

  // Delete from the database
  var kk = [];
  kk.push(feed);
  self.p_feedRemoveList(kk);
}
Feeds.prototype.feedRemove = feedRemove;

// object Feeds.feedMarkUnsubscribed
// Marks a feed as unsubscribed (permits undo)
function feedMarkUnsubscribed(feedUrl, isUnsubscribed)
{
  var self = this;

  // Search for feed f
  var f = feeds_ns.emptyRssHeader();
  f.m_url = feedUrl;

  // find if a feed with this URL is already in m_rssFeeds[]
  var index = self.m_rssFeeds.binarySearch(f, compareRssHeadersByUrl);
  if (index < 0)
  {
    console.log('Feeds.update: error, ' + f.m_url + ' is unknown');
    return;
  };
  var target = feeds_ns.copyRssHeader(self.m_rssFeeds[index]);

  target.m_is_unsubscribed = isUnsubscribed;

  var flagUpdatedHeader = self.p_feedUpdateHeader(index, target);
  if (flagUpdatedHeader)  // Record any changes in IndexedDB
    self.p_feedRecord(target);
}
Feeds.prototype.feedMarkUnsubscribed = feedMarkUnsubscribed;

// object Feeds.feedSetTags
// Sets the tags field of a RSSHeader
// returns error code:
// 0 -- no error
// 1 -- feed with this URL doesn't exist in the list of feeds
function feedSetTags(feedUrl, tags)
{
  var self = this;

  var targetFeed = feeds_ns.emptyRssHeader();
  targetFeed.m_url = feedUrl;
  targetFeed.m_title = feedUrl;

  // Find insertion point into the sorted m_rssFeeds[]
  var m = self.m_rssFeeds.binarySearch(targetFeed, compareRssHeadersByUrl);
  if (m < 0)  // Entry with this url doesn't exist
    return 1;

  targetFeed = self.m_rssFeeds[m];
  targetFeed.m_tags = tags;

  // Notify event subscribers
  var updated = new Array();
  updated.push(targetFeed);
  self.m_feedsCB.onRssUpdated(updated);

  // Update the database record (IndexedDb)
  self.p_feedRecord(targetFeed);
  return 0;
}
Feeds.prototype.feedSetTags = feedSetTags;

// object Feeds.feedDumpEntries
// debug feed print
function feedDumpEntries(feed)
{
  var self = this;
  var i = 0;
  var keys = Object.keys(feed.x_items);

  for (i = 0; i < keys.length; ++i)
  {
    var t = feed.x_items[keys[i]];
    var x = t.m_date;

    var d = i + ': ' + utils_ns.dateToStr(x);
    log.info(d);
    d = i + ': ' + t.m_link;
    log.info(d);
    if (false)
    {
      d = i + ': ' + t.m_hash;
      log.info(d);
      d = i + ': ' + t.m_title;
      log.info(d);
    }
    if (false)
    {
      d = i + ': ' + t.m_description;
      log.info(d);
    }
  }
  console.log('total of ' + keys.length + ' items');
}
Feeds.prototype.feedDumpEntries = feedDumpEntries;

// object Feeds.p_feedRecordEntry
// Records an RSS entry into the IndexedDB 'rss_data'
// Write operation is invoked only if the entry with this key is not
// already stored
function p_feedRecordEntry(feedUrl, newEntry, cbWriteDone)
{
  var self = this;

  // Compute the key for m_rssurl_date
  var sha1 = CryptoJS.SHA1(feedUrl);
  newEntry.m_rssurl_date = sha1.toString() + "_" + utils_ns.dateToStrStrict(newEntry.m_date);

  var newEntry2 = feeds_ns.copyRssEntry(newEntry);
  var s = self.m_rss_entry_cnt;

  // Insert entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_data'], 'readwrite');
  tran.oncomplete = function (event)
      {
        log.trace('db: update transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: update transaction aborted (' + s + ')');
      };
  tran.onerror = function (event) {
        log.error('db: update transaction error');
      };
  var store = tran.objectStore('rss_data');
  log.trace('db check for hash (' + self.m_rss_entry_cnt + '): ' + newEntry2.m_hash);
  var req = store.get(newEntry2.m_hash);
  ++self.m_rss_entry_cnt;
  req.onsuccess = function(event)
      {
        var data = req.result;
        if (data === undefined)
        {
          log.trace('db: write entry (' + s + '): [' + newEntry2.m_link + ']');
          var reqAdd = store.put(utils_ns.marshal(newEntry2, 'm_'));
          reqAdd.onsuccess = function(event)
              {
                var data = reqAdd.result;
                log.trace('db: entry (' + s + ') added: [' + newEntry2.m_link + ']');
                cbWriteDone(0);
              }
          reqAdd.onerror = function(event)
              {
                log.error('db: entry (' + s + ') error [' + newEntry2.m_link + ']');
                log.error('db: entry (' + s + ') error msg: ' + reqAdd.error.message);
                cbWriteDone(1);
              }
        }
        else
        {
           cbWriteDone(3);
          //log.info('db: entry (' + s + ') already in [' + newEntry2.m_link + ']');
        }
      }
}
Feeds.prototype.p_feedRecordEntry = p_feedRecordEntry;

// object Feeds.feedUpdateEntry
// Updates an entry in the IndexedDB
// 1. Reads the entry
// 2. Calls cbUpdate() which can change some of the entry fields
// 3. Records the entry in the IndexedDB
function feedUpdateEntry(entryHash, cbUpdate)
{
  var self = this;

  var s = self.m_rss_entry_cnt;

  // Entry goes into table 'rss_data'
  var tran = self.m_db.transaction(['rss_data'], 'readwrite');
  tran.oncomplete = function (event)
      {
        log.info('db: update transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: update transaction aborted (' + s + ')');
      };
  tran.onerror = function (event) {
        log.error('db: update transaction error');
      };
  var store = tran.objectStore('rss_data');
  log.trace('db: check for hash (' + self.m_rss_entry_cnt + '): ' + entryHash);
  var req = store.get(entryHash);
  ++self.m_rss_entry_cnt;
  req.onsuccess = function(event)
      {
        var data = req.result;
        var newEntry = null;
        var shouldWrite = false;
        var c = 0;

        if (data === undefined)
        {
          log.info('db: update entry (' + s + '): [' + entryHash + '], not found');

          // Record with this hash is not in the DB
          // Then create a new empty entry and ask cbUpdate() what to do
          newEntry = feeds_ns.emptyRssEntry();
          c =  cbUpdate(0, newEntry);
        }
        else
        {
          // Ask for updated data
          newEntry = feeds_ns.copyRssEntry(data);
          c = cbUpdate(0, newEntry);
        }

        if (c != 0)
        {
          log.info('db: entry (' + s + ') no update needed: [' + newEntry.m_link + ']');
          return;
        }

        var reqAdd = store.put(utils_ns.marshal(newEntry, 'm_'));
        reqAdd.onsuccess = function(event)
            {
              var data = reqAdd.result;
              log.trace('db: entry (' + s + ') updated: [' + newEntry.m_link + ']');
            }
        reqAdd.onerror = function(event)
            {
              log.error('db: entry (' + s + ') error [' + newEntry.m_link + ']');
              log.error('db: entry (' + s + ') error msg: ' + reqAdd.error.message);
            }
      }
}
Feeds.prototype.feedUpdateEntry = feedUpdateEntry;

// object Feeds.markEntryAsRead
// Mark entry as read in the local DB
// Send update to remote DB
function markEntryAsRead(entryHash, isRead)
{
  var self = this;

  self.feedUpdateEntry(entryHash,
      function(state, dbEntry)
      {
        if (state == 0)
        {
          utils_ns.assert(dbEntry.m_hash == entryHash, 'markAsRead: bad data');

          if (dbEntry.m_is_read == isRead)  // Already in the state it needs to be?
            return 1;  // Don't record in the DB
          else
          {
            dbEntry.m_is_read = isRead;
            self.p_rtableSyncEntry(dbEntry);
            return 0;  // Record in the DB
          }
        }
        else if (state == 1)
        {
          log.error('db: update entry (' + s + '): [' + entryHash + '], error not found');
          return 1;  // Don't record in the DB
        }
      });
}
Feeds.prototype.markEntryAsRead = markEntryAsRead;

// object Feeds.updateEntriesAll
// Walk over all records for RSS entries (table: rss_data), apply any
// changed from a cbUpdate() callback.
function updateEntriesAll(cbUpdate)
{
  var self = this;

  log.info('db: update all...');
  // Insert entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_data'], 'readwrite');
  tran.oncomplete = function (event)
      {
        log.trace('db: read transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: read transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: read transaction error');
      };
  var store = tran.objectStore('rss_data');
  var cursor = store.openCursor();  // navigate all entries
  cursor.onsuccess = function(event)
      {
        var req = null;

        var cursor = event.target.result;
        if (!cursor)
        {
          cbUpdate(null);  // Tell the callback we are done
          return;
        }

        var entry = cursor.value;

        // Call the update callback for this value
        var r = cbUpdate(cursor.value);
        if (r == 0)
        {
          return;  // done with all entries
        }
        else if (r == 1)  // Write new value and move to the next
        {
          req = cursor.update(cursor.value);
          req.onsuccess = function(event)
              {
                var data = req.result;
                log.info('db: update success: ' + req.result);
              }
          req.onerror = function(event)
              {
                log.error('db: update error msg: ' + req.error.message);
              }
          cursor.continue();
        }
        else if (r == 2)  // Don't write anything, move to the next
        {
          cursor.continue();
        }
      }
}
Feeds.prototype.updateEntriesAll = updateEntriesAll;

// object Feeds.p_feedUpdate
// update fields and entries in m_rssFeeds[] that are new
function p_feedUpdate(feedHeaderNew, cbWriteDone)
{
  var self = this;

  // find if a feed with this URL is already in m_rssFeeds[]
  var index = self.m_rssFeeds.binarySearch(feedHeaderNew, compareRssHeadersByUrl);
  if (index < 0)
  {
    console.log('Feeds.update: error, ' + feedHeaderNew.m_url + ' is unknown');
    return null;
  };
  var target = self.m_rssFeeds[index];

  // Overwrite fields that are meta-data and can't come
  // from the feed's source website
  feedHeaderNew.m_is_unsubscribed = target.m_is_unsubscribed;
  feedHeaderNew.m_tags = target.m_tags;

  // Check if any fields of rssFeed header have new values
  var flagUpdatedHeader = self.p_feedUpdateHeader(index, feedHeaderNew);
  if (flagUpdatedHeader)  // Record any changes in IndexedDB
    self.p_feedRecord(feedHeaderNew);

  // Send each entry in the RSS feed to the database
  // for possible write operation
  var i = 0;
  var keysNew = Object.keys(feedHeaderNew.x_items);
  var keyNew = '';
  var newEntry = null;
  var cntDone = 0;
  for (i = 0; i < keysNew.length; ++i)
  {
    keyNew = keysNew[i];
    newEntry = feedHeaderNew.x_items[keyNew];
    // Record a new entry if not already in the database
    ++cntDone;
    self.p_feedRecordEntry(target.m_url, newEntry,
       function(state)  // CB: write operation completed
       {
         --cntDone;
         if (cntDone == 0)
         {
           if (cbWriteDone != null)
             cbWriteDone();
         }
       });
  }

  return target;
}
Feeds.prototype.p_feedUpdate = p_feedUpdate;

// object Feeds.p_feedsUpdateAll
// Walk over all feeds (RssHeaders) from IndexedDB (table: rss_subscriptions),
// apply any changed from a cbUpdate() callback.
function p_feedsUpdateAll(cbUpdate)
{
  var self = this;

  log.info('db: feeds update all...');
  // Insert entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_subscriptions'], 'readwrite');
  tran.oncomplete = function (event)
      {
        log.trace('db: read transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: read transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: read transaction error');
      };
  var store = tran.objectStore('rss_subscriptions');
  var cursor = store.openCursor();  // navigate all entries
  cursor.onsuccess = function(event)
      {
        var req = null;

        var cursor = event.target.result;
        if (!cursor)
        {
          cbUpdate(null);  // Tell the callback we are done
          return;
        }

        var entry = cursor.value;

        // Call the update callback for this value
        var r = cbUpdate(cursor.value);
        if (r == 0)
        {
          return;  // done with all entries
        }
        else if (r == 1)  // Write new value and move to the next
        {
          req = cursor.update(cursor.value);
          req.onsuccess = function(event)
              {
                var data = req.result;
                log.info('db: update success: ' + req.result);
              }
          req.onerror = function(event)
              {
                log.error('db: update error msg: ' + req.error.message);
              }
          cursor.continue();
        }
        else if (r == 2)  // Don't write anything, move to the next
        {
          cursor.continue();
        }
      }
}
Feeds.prototype.p_feedsUpdateAll = p_feedsUpdateAll;

// object Feeds.feedReadEntriesAll
// Reads from the database, all entries (flat)
// 1. Read until cbFilter returns 0
function feedReadEntriesAll(cbFilter)
{
  var self = this;

  log.info('db: read all...');
  // Insert entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_data'], 'readonly');
  tran.oncomplete = function (event)
      {
        log.trace('db: read transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: read transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: read transaction error');
      };
  var store = tran.objectStore('rss_data');
  var cursor = store.openCursor();  // navigate all entries
  cursor.onsuccess = function(event)
      {
        var cursor = event.target.result;
        if (!cursor)
        {
          cbFilter(null);
          return;  // done with all entries
        }

        var entry = cursor.value;

        // Call the filter callback for this value
        var r = cbFilter(entry);
        if (r == 0)
        {
          return;  // done with all entries
        }

        cursor.continue();
      }
}
Feeds.prototype.feedReadEntriesAll = feedReadEntriesAll;

// object Feeds.feedReadEntries
// Reads from the database:
// 1. starting from _starTime_
// 2. read until cbFilter returns 0
function feedReadEntries(feedUrl, startTime, isDescending, cbFilter)
{
  var self = this;

  log.info('db: read for ' + feedUrl + '...');
  // Compute the key for rssurl_date based on url + startTime
  var sha1 = CryptoJS.SHA1(feedUrl);
  var key_rssurl_curdate = sha1.toString() + "_" + utils_ns.dateToStrStrict(startTime);
  var key_rssurl_oldestdate = sha1.toString() + "_" + utils_ns.dateToStrStrict(new Date(0));
  log.trace(utils_ns.dateToStrStrict(new Date(0)));
  log.trace(utils_ns.dateToStrStrict(startTime));
  var sha1Url = sha1.toString();

  // Insert entry in m_dbSubscriptions
  var tran = self.m_db.transaction(['rss_data'], 'readonly');
  tran.oncomplete = function (event)
      {
        log.trace('db: read transaction completed');
      };
  tran.onabort = function (event)
      {
        log.error('db: read transaction aborted');
      };
  tran.onerror = function (event)
      {
        log.error('db: read transaction error');
      };
  var store = tran.objectStore('rss_data');
  var index = store.index('rssurl_date');
  var range = IDBKeyRange.bound(key_rssurl_oldestdate, key_rssurl_curdate);
  var cursor = index.openCursor(range, 'prev');  // navigate in descending order of startTime
  var entries = [];
  cursor.onsuccess = function(event)
      {
        var cursor = event.target.result;
        if (!cursor)
        {
          cbFilter(null);
          return;  // done with all entries
        }

        var entry = cursor.value;

        // Call the filter callback for this value
        var r = cbFilter(entry);
        if (r == 0)
        {
          return;  // done with all entries
        }

        // Check if the URL portion of the hash matches
        var h = entry.m_rssurl_date.indexOf('_');
        var m_rssurl = entry.m_rssurl_date.slice(0, h);
        if (m_rssurl != sha1Url)
        {
          // This should never happen
          // Just an extra verification of db results
          log.error('db: not the key we need');
          cbFilter(null);
        }

        cursor.continue();
      }
}
Feeds.prototype.feedReadEntries = feedReadEntries;

// object Feeds.feedGetList
// return a list of all feeds
// TODO: remove, this is no longer used outside Feeds
function feedGetList()
{
  var self = this;

  var feedsList = new Array();

  var i = 0;
  for(i = 0; i < self.m_rssFeeds.length; ++i)
    feedsList.push(self.m_rssFeeds[i]);

  return feedsList;
}
Feeds.prototype.feedGetList = feedGetList;

// object Feeds.feedGetTagsList
// return a list of all tags on feeds
function feedGetTagsList()
{
  var self = this;

  var tagsList = new Array();

  var i = 0;
  var j = 0;
  var tag = '';
  var found = false;
  // Iterate through all rssFeeds
  for (i = 0; i < self.m_rssFeeds.length; ++i)
  {
    tag = self.m_rssFeeds[i].m_tags;
    if (tag == null || tag == '')
      continue;

    // Check if thsi tag is not already in the list
    found = false;
    for (j = 0; j < tagsList.length; ++j)
    {
      if (tag == tagsList[j])
      {
        found = true;
        break;
      }
    }

    if (!found)
      tagsList.push(tag);
  }

  return tagsList;
}
Feeds.prototype.feedGetTagsList = feedGetTagsList;

// object Feeds.p_feedUpdateHeader
// update header of a feed with data from a new updated feed
function p_feedUpdateHeader(toUpdate, updated)
{
  var self = this;
  var target = self.m_rssFeeds[toUpdate];
  var wasUpdated = false;

  if (updated.m_title != target.m_title)
  {
    console.log('new title: ' + updated.m_title + ' (old: ' + target.m_title + ')');
    target.m_title = updated.m_title;
    wasUpdated = true;
  };
  if (updated.m_link != target.m_link)
  {
    console.log('new link: ' + updated.m_link + ' (old: ' + target.m_link + ')');
    target.m_link = updated.m_link;
    wasUpdated = true;
  };
  if (updated.m_description != target.m_description)
  {
    console.log('new description: ' + updated.m_description + ' ' +
                '(old: ' + target.m_description + ')');
    target.m_description = updated.m_description;
    wasUpdated = true;
  };
  if (updated.m_rss_type != target.m_rss_type)
  {
    console.log('new rss_type: ' + updated.m_rss_type + ' ' +
                '(old: ' + target.m_rss_type + ')');
    target.m_rss_type = updated.m_rss_type;
    wasUpdated = true;
  };
  if (updated.m_rss_version != target.m_rss_version)
  {
    console.log('new rss_version: ' + updated.m_rss_version + ' ' +
                '(old: ' + target.m_rss_version + ')');
    target.m_rss_version = updated.m_rss_version;
    wasUpdated = true;
  };
  if (target.m_date != null)
  {
    // Some feeds reported m_date without in fact changing any of the feed's items
    // Ignore this for now
    if (false)
    {
      if (updated.m_date.getTime() != target.m_date.getTime())
      {
        console.log('new updated: ' + updated.m_date + ' ' +
                    '(old: ' + target.m_date + ')');
        target.m_date = updated.m_date;
        wasUpdated = true;
      }
    }
  }
  else
  {
    // First time Date is set in feeld m_date
    console.log('new updated: ' + updated.m_date + ' ' +
                '(old: ' + target.m_date + ')');
    target.m_date = updated.m_date;
    wasUpdated = true;
  }
  if (updated.m_is_unsubscribed != target.m_is_unsubscribed)
  {
    console.log('new is_unsubscribed: ' + updated.m_is_unsubscribed + ' ' +
                '(old: ' + target.m_is_unsubscribed + ')');
    target.m_is_unsubscribed = updated.m_is_unsubscribed;
    wasUpdated = true;
  }

  return wasUpdated;
}
Feeds.prototype.p_feedUpdateHeader = p_feedUpdateHeader;

// object Feeds.p_fetchRss
// Fetch an RSS feed by its url, process it and call the done callback,
// and after that the callback for write completed
function p_fetchRss(urlRss, cbDone, cbWriteDone)
{
  var self = this;

  feeds_ns.fetchRss(urlRss,
      function(c, feed, errorMsg)
      {
        if (c == 0)
        {
          console.log('rss fetch, success: ' + feed.m_url);
          var target = self.p_feedUpdate(feed,
              function()  // CB: write operation completed
              {
                // This CB is useful for when a newly added feed needs
                // to be displayed for the first time, it relies on
                // the fact that the data is already in the IndexedDB
                if (cbWriteDone != null)
                  cbWriteDone();
              });
          if (target != null)
          {
            // Notify event subscribers
            var updated = new Array();
            updated.push(target);
            self.m_feedsCB.onRssUpdated(updated);
          }
        }
        else
          console.error('rss fetch, failed: ' + errorMsg + ', for: ' + feed.m_url);

        if (cbDone != null)
          cbDone();
      });
}
Feeds.prototype.p_fetchRss = p_fetchRss;

// object Feeds.p_reschedulePoll
// Set the delay before next iteration of the poll loop
function p_reschedulePoll(delayInSeconds)
{
  var self = this;

  var delay = delayInSeconds * 1000;
  self.m_timeoutID = setTimeout(p_poll, delay, self);
}
Feeds.prototype.p_reschedulePoll = p_reschedulePoll;

// object Feeds.p_poll
// fetch loop
// schedule new fetch operation at the end of the previous
function p_poll(self)
{
  if (self.m_rssFeeds.length == 0)
  {
    console.log(utils_ns.dateToStr(new Date()) +
                ' the feeds list is empty -- poll loop completed, wait...');
    self.p_reschedulePoll(60);
    return;
  }

  var urlRss = self.m_rssFeeds[self.m_pollIndex].m_url
  log.info('fetch: ' + self.m_pollIndex + ' url: ' + urlRss);
  ++self.m_pollIndex;

  self.p_fetchRss(urlRss, function()
      {
        var delay = 1;
        if (self.m_pollIndex >= self.m_rssFeeds.length)
        {
          // Reached the end of the poll loop
          self.m_pollIndex = 0;
          delay = 60;
          console.log(utils_ns.dateToStr(new Date()) +' -- poll loop completed, wait...');
        }
        self.p_reschedulePoll(delay);
      },
      null);
}
Feeds.prototype.p_poll = p_poll;

// export to feeds_ns namespace
feeds_ns.Feeds = Feeds;
})();
