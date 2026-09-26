import {readFile} from 'node:fs/promises';
import {captureBatchSchema} from '@magic/contracts';
import {resolveDeadline} from '@magic/domain';
const batch=captureBatchSchema.parse(JSON.parse(await readFile(new URL('../fixtures/course.json',import.meta.url),'utf8')));
console.log(JSON.stringify({mode:'synthetic fixture',source:batch.source.label,items:batch.resources.map(r=>({title:r.title,deadline:resolveDeadline(r.deadlines)}))},null,2));
