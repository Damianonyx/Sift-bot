import { backupDatabase, inspectDatabase, restoreDatabase, StorageMaintenanceError } from '../src/storage-maintenance.js';

// Explicit paths only; no token/config loading, provider requests or row output.
const [operation,...args]=process.argv.slice(2);
try {
  let report;
  if(operation==='inspect'&&args.length<=1)report=inspectDatabase(args[0]??process.env.SIFT_DATA_DIR??'.sift');
  else if(operation==='backup'&&args.length===2)report=await backupDatabase(args[0],args[1]);
  else if(operation==='restore'&&args.length===2)report=await restoreDatabase(args[0],args[1]);
  else {
    console.error('Usage: node scripts/storage.js inspect [DATA_DIR] | backup DATA_DIR NEW_BACKUP_FILE | restore BACKUP_FILE NEW_DATA_DIR');
    process.exitCode=1;
  }
  if(report)console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(error instanceof StorageMaintenanceError?error.message:'Storage maintenance failed. No raw paths or database contents are displayed.');
  process.exitCode=1;
}
