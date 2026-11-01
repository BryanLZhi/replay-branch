// site/index.html = template + sample replay log (for the embed's first render) + app; optional password hash from env RBV_PW_HASH
import fs from 'fs';
const sample = JSON.parse(fs.readFileSync('site/sample.json', 'utf8'));
const log = sample.log.replace(/\//g, '\\/');   // the embed un-escapes \/ (keeps </script> from ending the tag)
let html = fs.readFileSync('template.html', 'utf8')
  .replace('/*REPLAY_ID*/', () => sample.id)
  .replace('/*REPLAY_LOG*/', () => log)
  .replace('/*APP_JS*/', () => fs.readFileSync('app3.js', 'utf8'));
if (process.env.RBV_PW_HASH) html = html.replace('/*PW_HASH*/', () => process.env.RBV_PW_HASH);
fs.writeFileSync('site/index.html', html);
console.log('index.html', html.length, process.env.RBV_PW_HASH ? 'gate on' : 'gate off');
