import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {notificationReadIds,notificationView} from './notifications.mjs';

export function createNotificationStore(dataDir){
  const path=join(dataDir,'notifications.sqlite'),db=new DatabaseSync(path);
  try {chmodSync(path,0o600);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notification_reads(accountId TEXT NOT NULL,notificationId TEXT NOT NULL,readAt TEXT NOT NULL,PRIMARY KEY(accountId,notificationId));');}
  catch(error){db.close();throw error;}
  const readIds=accountId=>new Set(db.prepare('SELECT notificationId FROM notification_reads WHERE accountId=?').all(accountId).map(row=>row.notificationId));
  return {
    view(accountId,items){return notificationView(items,readIds(accountId));},
    mark(accountId,input,items){
      const ids=notificationReadIds(input,items);db.exec('BEGIN IMMEDIATE');
      try {const insert=db.prepare('INSERT OR IGNORE INTO notification_reads VALUES(?,?,?)');for(const id of ids)insert.run(accountId,id,new Date().toISOString());db.exec('COMMIT');}
      catch(error){db.exec('ROLLBACK');throw error;}
      return notificationView(items,readIds(accountId));
    },
    close(){db.close();}
  };
}
