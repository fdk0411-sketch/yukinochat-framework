import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { live2dAssetForRoute } from '../live2d-assets.mjs';
import renderer from '../public/live2d-avatar.js';

test('Live2D routes admit only owned model resources and explicitly bundled scripts', () => {
  assert.deepEqual(live2dAssetForRoute('/live2d/vendor/pixi.min.js'),['live2d/vendor/pixi.min.js','text/javascript; charset=utf-8']);
  assert.deepEqual(live2dAssetForRoute('/live2d/yukino/yukino_seihuku.moc3'),['live2d/yukino/yukino_seihuku.moc3','application/octet-stream']);
  assert.deepEqual(live2dAssetForRoute('/live2d/yukino/original-face/original-face.model3.json'),['live2d/yukino/original-face/original-face.model3.json','application/json; charset=utf-8']);
  assert.deepEqual(live2dAssetForRoute('/live2d/yukino/original-face/original-face.2048/texture_00.png'),['live2d/yukino/original-face/original-face.2048/texture_00.png','image/png']);
  for(const route of [
    'https://outside.test/live2d/yukino/a.json','//outside.test/live2d/yukino/a.json',
    '/live2d/yukino/../secret.json','/live2d/yukino/%2e%2e/secret.json','/live2d/yukino/a%2fsecret.json',
    '/live2d/yukino/a\\b.json','/live2d/yukino/a.json:secret','/live2d/yukino/.hidden.json',
    '/live2d/yukino/a.svg','/live2d/yukino/a.js','/live2d/yukino/a.html','/live2d/yukino/a.png?url=https://outside.test',
    '/live2d/vendor/other.js','/live2d/vendor/pixi.min.js.map','/live2d/vendor/../secrets.json',
    '/live2d/other-model/shape.moc3','/voice/config.json','/live2d/yukino/a/b/c/deep.json',
  ]) assert.equal(live2dAssetForRoute(route),null,route);
});

test('framework preview deliberately excludes proprietary SDK and character assets', async () => {
  const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
  await assert.rejects(access(path.join(publicRoot,'live2d')), {code:'ENOENT'});
  await assert.rejects(access(path.join(publicRoot,'avatar-assets')), {code:'ENOENT'});
  const html=await readFile(path.join(publicRoot,'index.html'),'utf8');
  const app=await readFile(path.join(publicRoot,'app.js'),'utf8');
  assert.ok(!html.includes('src="/live2d-avatar.js"'));
  assert.ok(!app.includes("fetch('/avatar-manifest.json'"));
  assert.ok(app.includes('dynamic:false'));
});
