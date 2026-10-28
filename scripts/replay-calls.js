import { replayRecordedCalls } from '../src/call-replay.js';

const [directory,user,after='0',...extra]=process.argv.slice(2);
if(!directory||!/^\d+$/.test(user??'')||!/^\d+$/.test(after)||extra.length) {
  console.error('Usage: node scripts/replay-calls.js DATA_DIRECTORY TELEGRAM_USER_ID [AFTER_CALL_ID]');
  process.exitCode=1;
} else {
  try {console.log(JSON.stringify(replayRecordedCalls({directory,userId:Number(user),after:Number(after)}),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
