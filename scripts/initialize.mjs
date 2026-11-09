import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const dir of ['reply','voice']){const dst=path.join(root,dir,'config.json');try{await fs.copyFile(path.join(root,dir,'config.example.json'),dst,fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}}
console.log('Configuration ready; existing settings preserved.');
