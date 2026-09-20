import fs from 'node:fs';

export function saveRecordingJson(file, data) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  // Windows readers and antivirus can briefly lock the replaced destination.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
