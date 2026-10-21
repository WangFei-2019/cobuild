import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeServiceOrigin} from '../src/service-origin.js';

test('service entry preserves HTTPS origins and custom ports, allowing HTTP only for local development',()=>{
 assert.equal(normalizeServiceOrigin(' https://team.example.com:5175/ '),'https://team.example.com:5175');
 assert.equal(normalizeServiceOrigin('https://123.57.227.212:5175'),'https://123.57.227.212:5175');
 assert.equal(normalizeServiceOrigin('http://127.0.0.1:5175'),'http://127.0.0.1:5175');
 assert.equal(normalizeServiceOrigin('http://[::1]:4173'),'http://[::1]:4173');
 assert.throws(()=>normalizeServiceOrigin('http://localhost:4173',{allowLocalhost:false}),/HTTPS/);
});
test('service entry rejects credentials, protocols, links with tokens and ambiguous URL separators',()=>{
 for(const value of ['',null,'team.example.com','javascript:alert(1)','file:///etc/passwd','http://123.57.227.212:5175','https://name:password@example.com','https://example.com/invite/token','https://example.com?key=private','https://example.com#/login','https://example.com\\evil','https://exam\nple.com','http://localhost.example.com'])assert.throws(()=>normalizeServiceOrigin(value),value);
});
