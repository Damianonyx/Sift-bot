import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export class StorageMaintenanceError extends Error {
  constructor(code) {
    const messages={
      SOURCE_UNAVAILABLE:'The source database is missing, unreadable, or not a regular file.',
      DATABASE_INVALID:'The source is not an intact Sift database. No restore was performed.',
      DESTINATION_EXISTS:'The destination already exists. Choose a new file or directory; existing data is never overwritten.',
      DESTINATION_UNAVAILABLE:'The destination parent directory is missing or cannot be written.',
      OPERATION_FAILED:'Storage maintenance failed. Existing source data was not replaced.',
    };
    super(messages[code]??messages.OPERATION_FAILED);this.code=code;
  }
}

const core=['agents','agent_receipts','runtime'];
function filePath(path) {
  try {
    const info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink())throw new Error();
    return realpathSync(path);
  } catch {throw new StorageMaintenanceError('SOURCE_UNAVAILABLE');}
}
function destinationPath(path) {
  const absolute=resolve(path);
  try {lstatSync(absolute);throw new StorageMaintenanceError('DESTINATION_EXISTS');}
  catch(error){if(error instanceof StorageMaintenanceError)throw error;if(error.code!=='ENOENT')throw new StorageMaintenanceError('DESTINATION_UNAVAILABLE');}
  try {
    const parent=realpathSync(dirname(absolute));
    if(!lstatSync(parent).isDirectory())throw new Error();
    return join(parent,basename(absolute));
  } catch {throw new StorageMaintenanceError('DESTINATION_UNAVAILABLE');}
}
function readDatabase(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');return db;}
  catch(error){db.close();throw error;}
}
function verify(db) {
  const rows=db.prepare('PRAGMA integrity_check').all();
  if(rows.length!==1||Object.values(rows[0])[0]!=='ok')throw new StorageMaintenanceError('DATABASE_INVALID');
  const tables=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name));
  if(core.some(name=>!tables.has(name)))throw new StorageMaintenanceError('DATABASE_INVALID');
  // Read the minimum persisted state shapes without returning user rows.
  db.prepare('SELECT user_id,revision,draft,approved FROM agents LIMIT 0').all();
  db.prepare('SELECT update_id,response FROM agent_receipts LIMIT 0').all();
  const offset=db.prepare("SELECT value FROM runtime WHERE key='offset'").get();
  if(!Number.isSafeInteger(offset?.value)||offset.value<0)throw new StorageMaintenanceError('DATABASE_INVALID');
  const pageCount=db.prepare('PRAGMA page_count').get().page_count;
  const pageSize=db.prepare('PRAGMA page_size').get().page_size;
  return {state:'present',integrity:'ok',tableCount:tables.size,databaseBytes:pageCount*pageSize};
}

/** Read-only inspection, no migration, application initialization or network. */
export function inspectDatabase(directory='.sift') {
  let db;
  const path=join(directory,'agents.sqlite');
  try {db=readDatabase(filePath(path));return verify(db);}
  catch(error){if(error instanceof StorageMaintenanceError)throw error;throw new StorageMaintenanceError('DATABASE_INVALID');}
  finally {db?.close();}
}

async function snapshot(source, destination) {
  let db,copy;
  try {
    db=readDatabase(filePath(source));verify(db);
    // Reserve restrictive permissions before SQLite opens the destination.
    const fd=openSync(destination,'wx',0o600);closeSync(fd);
    await backup(db,destination,{rate:100});
    copy=new DatabaseSync(destination);copy.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;');
    const report=verify(copy);copy.close();copy=null;
    chmodSync(destination,0o600);
    const syncFd=openSync(destination,'r');try{fsyncSync(syncFd);}finally{closeSync(syncFd);}
    return report;
  } finally {copy?.close();db?.close();}
}

/** Consistent online snapshot including committed WAL data; publishes atomically without overwrite. */
export async function backupDatabase(directory, outputFile) {
  const source=filePath(join(directory,'agents.sqlite')),destination=destinationPath(outputFile);
  let stage;
  try {
    stage=mkdtempSync(join(dirname(destination),'.sift-backup-'));chmodSync(stage,0o700);
    const temporary=join(stage,'snapshot.sqlite'),report=await snapshot(source,temporary);
    // A hard link on this same filesystem is an atomic no-replace publication.
    linkSync(temporary,destination);
    return {...report,operation:'backup',consistentSnapshot:true};
  } catch(error) {
    if(error instanceof StorageMaintenanceError)throw error;
    if(error.code==='EEXIST')throw new StorageMaintenanceError('DESTINATION_EXISTS');
    throw new StorageMaintenanceError('OPERATION_FAILED');
  } finally {if(stage)rmSync(stage,{recursive:true,force:true});}
}

/** Restore into a new private directory only. The previous runtime stays untouched. */
export async function restoreDatabase(backupFile, newDirectory) {
  const source=filePath(backupFile),destination=destinationPath(newDirectory);
  let made=false;
  try {
    // Validate before creating the destination, then validate the copied snapshot.
    let check;try{check=readDatabase(source);verify(check);}finally{check?.close();}
    mkdirSync(destination,{mode:0o700});made=true;
    const report=await snapshot(source,join(destination,'agents.sqlite'));
    return {...report,operation:'restore',scanStatePreserved:true,
      notice:'Saved scan and monitor states are preserved. Stop the old bot before starting a process with the restored directory.'};
  } catch(error) {
    if(made) {
      // Only delete files this operation can create; never recursively erase a
      // directory which another process might have populated.
      for(const suffix of ['', '-wal','-shm','-journal'])try{unlinkSync(join(destination,'agents.sqlite'+suffix));}catch{}
      try{rmdirSync(destination);}catch{}
    }
    if(error instanceof StorageMaintenanceError)throw error;
    if(error.code==='EEXIST')throw new StorageMaintenanceError('DESTINATION_EXISTS');
    throw new StorageMaintenanceError('OPERATION_FAILED');
  }
}
