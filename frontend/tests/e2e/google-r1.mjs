import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import {execFileSync,fork} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
const be=root+'/backend-js';
const fe=root+'/frontend';
const require=createRequire(be+'/package.json');
const requireFE=createRequire(fe+'/package.json');
const load=file=>import(pathToFileURL(be+'/'+file).href);
const {chromium}=requireFE('playwright-core');
const {createServer:createVite}=await import(pathToFileURL(requireFE.resolve('vite')).href);
const {SignJWT,generateKeyPair,exportJWK}=await import(pathToFileURL(require.resolve('jose')).href);
process.chdir(be);
const {loadSettings}=await load('src/core/config.js');
const {createPrismaClient}=await load('src/db/client.js');
const {createValkeyClient}=await load('src/core/valkey.js');
const {createApp}=await load('src/app.js');
if (!process.env.M01B_R1_DATABASE_URL || !process.env.M01B_R1_VALKEY_URL || !process.env.M01B_R1_BROWSER) throw Error('Explicit disposable M01B_R1_DATABASE_URL, M01B_R1_VALKEY_URL and M01B_R1_BROWSER required');
const dbUrl=new URL(process.env.M01B_R1_DATABASE_URL);
assert.equal(dbUrl.protocol,'postgresql:');
assert.equal(dbUrl.hostname,'127.0.0.1');
assert.equal(dbUrl.port,'5433');
assert.match(dbUrl.pathname, /^\/outpost_m01b_r1_[a-z0-9_]+$/);
assert.notEqual(dbUrl.pathname, '/outpost');
const db=dbUrl.pathname.slice(1);
const valkeyUrl=new URL(process.env.M01B_R1_VALKEY_URL);
assert(['redis:','rediss:'].includes(valkeyUrl.protocol));
assert.equal(valkeyUrl.hostname,'127.0.0.1');
assert(Number(valkeyUrl.port)>1024 && Number(valkeyUrl.port)!==6379);
const valkey=createValkeyClient(valkeyUrl.href);
const certDir=await fs.mkdtemp(path.join(os.tmpdir(),'outpost-r1-cert-'));
execFileSync(process.env.M01B_R1_OPENSSL || 'openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(certDir,'key.pem'),'-out',path.join(certDir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
const credentials={key:await fs.readFile(path.join(certDir,'key.pem')),cert:await fs.readFile(path.join(certDir,'cert.pem'))};
const keyPair=await generateKeyPair('RS256',{modulusLength:2048});
const jwk={...(await exportJWK(keyPair.publicKey)),kid:'fixture',alg:'RS256'};
const provider='https://accounts.google.com';
const tokenUrl='https://oauth2.googleapis.com/token';
const jwksUrl='https://www.googleapis.com/oauth2/v3/certs';
const callbackPath='/api/v1/auth/google/callback';
const activationHeader='x-acadboost-google-attempt';
const cookieName='outpost_refresh';
const secrets=new Set();
const calls=new Map();
const smsMessages=[];
let scenario, stage;
let exchanges=0,prisma,backend,appOrigin,fakeOrigin,appServer,fakeServer,browser,vite,hold,bootstrapHolds;
let restartChild;
let control;
const evidence={database:db,cases:{},network:[],cleanup:{}};
const save=()=>process.env.M01B_R1_EVIDENCE ? fs.writeFile(process.env.M01B_R1_EVIDENCE,JSON.stringify(evidence,null,2)) : Promise.resolve();
const listen=async server=>{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return server.address().port;
};
const close=async server=>{
  if(server?.listening){
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
};
const fakeFetch=async (url,options)=>{
  if(url===provider+'/.well-known/openid-configuration')return Response.json({issuer:provider,token_endpoint:tokenUrl,jwks_uri:jwksUrl});
  if(url===jwksUrl)return Response.json({keys:[jwk]});
  if(url===tokenUrl){
    exchanges++;
    const form=new URLSearchParams(options.body);
    const code=form.get('code');
    const entry=calls.get(code);
    assert(entry,'Simulator code missing');
    calls.delete(code);
    secrets.add(form.get('code_verifier'));
    assert.equal(form.get('redirect_uri'),appOrigin+callbackPath);
    const token=await new SignJWT({iss:provider,aud:'m01b-test',sub:entry.subject,nonce:entry.nonce,
      name:'Synthetic Google',email:entry.subject+'@example.test',email_verified:true})
      .setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuedAt().setExpirationTime('5m').sign(keyPair.privateKey);
    secrets.add(token);
    return Response.json({id_token:token});
  }
  throw Error('Unexpected external provider request');
};
const realFetch=globalThis.fetch;
const capture=[];
const writers=[];
for(const stream of [process.stdout,process.stderr]){
  const write=stream.write;
  writers.push([stream,write]);
  stream.write=function(chunk,...args){capture.push(String(chunk));return write.call(this,chunk,...args);};
}
const arm=(stage='body')=>{
  assert(!hold);
  const waiting=Promise.withResolvers();
  hold={...waiting,stage};
  return waiting.promise;
};
const waitFor=async (test,timeout=12000)=>{
  const limit=Date.now()+timeout;
  while(Date.now()<limit){
    if(await test())return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw Error('Fixture condition timed out');
};
try{
  prisma=createPrismaClient(dbUrl.href);
  process.env.VITE_GOOGLE_SIGN_IN_ENABLED='true';
  vite=await createVite({root:fe,server:{middlewareMode:true,hmr:false},appType:'spa'});
  fakeServer=httpsServer(credentials,(req,res)=>{
    const url=new URL(req.url,'https://127.0.0.1');
    const state=url.searchParams.get('state');
    const nonce=url.searchParams.get('nonce');
    if(!state||!nonce){res.writeHead(404);res.end();return;}
    const code=randomUUID();
    for(const secret of [state,nonce,code])secrets.add(secret);
    calls.set(code,{subject:scenario,nonce});
    const ok=appOrigin+callbackPath+'?'+new URLSearchParams({state,code,iss:provider});
    const cancel=appOrigin+callbackPath+'?'+new URLSearchParams({state,error:'access_denied'});
    const escape=s=>s.replaceAll('&','&amp;');
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    res.end('<!doctype html><a id="ok" href="'+escape(ok)+'">Continue</a><a id="cancel" href="'+escape(cancel)+'">Cancel</a>');
  });
  fakeOrigin='https://127.0.0.1:'+await listen(fakeServer);
  appServer=httpsServer(credentials,(req,res)=>{
    const path=req.url.split('?')[0];
    if(!path.startsWith('/api/')){vite.middlewares(req,res);return;}
    const isActivation=path==='/api/v1/auth/refresh'&&Boolean(req.headers[activationHeader]);
    const upstream=httpRequest({host:'127.0.0.1',port:backend.address().port,path:req.url,method:req.method,headers:req.headers},reply=>{
      const headers={...reply.headers};
      for(const cookie of headers['set-cookie']??[]){const value=cookie.split(';')[0].split('=')[1];if(value)secrets.add(value);}
      if(path==='/api/v1/auth/google/authorize'&&headers.location?.startsWith(provider+'/')){
        headers.location=fakeOrigin+new URL(headers.location).search;
      }
      if(path===callbackPath||isActivation)evidence.network.push({path,status:reply.statusCode,
        location:headers.location??null,activeCookie:(headers['set-cookie']??[]).some(c=>c.startsWith(cookieName+'='))});
      if(path==='/api/v1/auth/browser-context'&&bootstrapHolds){
        const chunks=[];
        reply.on('data',chunk=>chunks.push(chunk));
        reply.once('end',()=>bootstrapHolds.push({release:()=>{res.writeHead(reply.statusCode,headers);res.end(Buffer.concat(chunks));}}));
      }else if(isActivation&&reply.statusCode===200&&hold){
        const pending=hold;
        hold=null;
        if(pending.stage==='body'){res.writeHead(reply.statusCode,headers);res.flushHeaders();}
        const chunks=[];
        const body=new Promise((resolve,reject)=>{
          reply.on('data',chunk=>chunks.push(chunk));
          reply.once('end',()=>resolve(Buffer.concat(chunks)));
          reply.once('error',reject);
        });
        pending.resolve({body,release:async()=>{if(pending.stage==='headers')res.writeHead(reply.statusCode,headers);res.end(await body);},lose:()=>res.destroy()});
      }else {res.writeHead(reply.statusCode,headers);reply.pipe(res);}
    });
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.pipe(upstream);
  });
  appOrigin='https://localhost:'+await listen(appServer);
  const settings=loadSettings({...process.env,OUTPOST_ENV:'development',OUTPOST_DATABASE_URL:dbUrl.href,OUTPOST_VALKEY_URL:valkeyUrl.href,OUTPOST_GOOGLE_HANDOFF_ENABLED:'true',OUTPOST_PUBLIC_APP_ORIGIN:appOrigin,
    OUTPOST_GOOGLE_REDIRECT_URI:appOrigin+callbackPath,OUTPOST_GOOGLE_CLIENT_ID:'m01b-test',
    OUTPOST_GOOGLE_CLIENT_SECRET:'m01b-synthetic-client-secret',OUTPOST_AUTH_SIGNING_KEY:randomBytes(48).toString('base64url'),
    OUTPOST_OTP_HMAC_KEY:randomBytes(48).toString('base64url'),OUTPOST_SMS_PROVIDER:'development'});
  secrets.add(settings.googleClientSecret);
  globalThis.fetch=fakeFetch;
  try{backend=httpServer(createApp({prisma,settings,redisClient:valkey,smsProvider:{send:async message=>smsMessages.push(message)}}));}
  finally{globalThis.fetch=realFetch;}
  await listen(backend);
  evidence.origins={app:appOrigin,provider:fakeOrigin};
  browser=await chromium.launch({executablePath:process.env.M01B_R1_BROWSER,headless:true,
    args:['--disable-background-networking','--no-first-run']});
  const context=()=>browser.newContext({ignoreHTTPSErrors:true});
  // The fixture owns this disposable Valkey instance. Clear only the exact
  // bootstrap counter for its loopback backend peer between independent cases.
  const resetBootstrapLimit=()=>valkey.eval("return redis.call('DEL', KEYS[1])",{keys:[
    `outpost:auth-browser-bootstrap:v1:${createHash('sha256').update('127.0.0.1').digest('hex')}`
  ]});
  const at=async(ctx,path)=>{const page=await ctx.newPage();await page.goto(appOrigin+path);return page;};
  const begin=async(ctx,subject)=>{
    scenario=subject;
    await resetBootstrapLimit();
    const page=await at(ctx,'/auth/google');
    await page.getByRole('button',{name:'Continue with Google'}).click();
    await page.waitForURL(u=>u.origin===fakeOrigin);
    return page;
  };
  const accept=page=>page.locator('#ok').click({noWaitAfter:true});
  const activeCookie=async ctx=>(await ctx.cookies(appOrigin+'/api/v1/auth/refresh')).find(c=>c.name===cookieName);
  const liveSessions=async subject=>{
    const identity=await prisma.oAuthIdentity.findUnique({where:{provider_providerSubject:{provider:'google',providerSubject:subject}}});
    return identity ? prisma.authSession.count({where:{userId:identity.userId,revokedAt:null,replacedBySessionId:null}}) : 0;
  };
  const activateCount=()=>evidence.network.filter(e=>e.path==='/api/v1/auth/refresh').length;
  const settled=page=>page.evaluate(()=>window.testResult);
  const startLogin=(page,input)=>page.evaluate(async ({identifier,password})=>{
    const client=await import('/src/shared/api/client.js');
    window.testResult=client.authenticateSession('/auth/password/login',{identifier,password}).then(
      u=>({status:200,id:u.id}), e=>({status:e.status??0,code:e.code}));
  },input);
  const startLogout=page=>page.evaluate(async ()=>{
    const client=await import('/src/shared/api/client.js');
    window.testResult=client.endAuthSession().then(()=>({status:204}), e=>({status:e.status??0,code:e.code}));
  });
  const runId=randomBytes(5).toString('hex');
  const loginInput={identifier:`m01b-${runId}@example.test`,password:'safe-test-'+randomUUID()};
  secrets.add(loginInput.password);
  const initial=await context();
  const registered=await initial.request.post(appOrigin+'/api/v1/auth/password/register',{data:{
    email:loginInput.identifier,password:loginInput.password,display_name:'Synthetic Password',
    username:`m01b_${runId}`,account_type:'student'}});
  assert.equal(registered.status(),201);
  const passwordId=(await registered.json()).id;
  await initial.close();
  control=await context();
  const controlLogin=await control.request.post(appOrigin+'/api/v1/auth/password/login',{
    headers:{Origin:appOrigin,'X-Acadboost-Auth-Intent':randomUUID()},data:loginInput
  });
  assert.equal(controlLogin.status(),200);
  let controlToken=(await controlLogin.json()).access_token;
  secrets.add(controlToken);

  let a,b,page,companion;
  if (!process.env.M01B_R1_ONLY_LATE && !process.env.M01B_R1_ONLY_RESTART && !process.env.M01B_R1_ONLY_BOOTSTRAP) {
  a=await context(); b=await context();
  page=await begin(a,'m01b-'+runId+'-happy');
  const copied=await page.locator('#ok').getAttribute('href');
  const previousExchanges=exchanges;
  const wrong=await b.request.get(copied,{maxRedirects:0});
  assert.equal(wrong.status(),303);
  assert.equal(wrong.headers().location,'/auth/google/complete?result=invalid');
  assert.equal(exchanges,previousExchanges);
  assert.equal(await liveSessions('m01b-'+runId+'-happy'),0);
  await accept(page);
  await page.waitForURL(u=>u.pathname==='/app/student');
  assert.equal(exchanges,previousExchanges+1);
  const good=await activeCookie(a);
  assert(good?.secure&&good.httpOnly&&good.sameSite==='Strict'&&good.path==='/api/v1/auth');
  assert.equal(await liveSessions('m01b-'+runId+'-happy'),1);
  const [restored] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me' && response.status() === 200)
      .then(response=>response.json()),
    page.reload(),
  ]);
  await page.waitForURL(u=>u.pathname==='/app/student');
  const happyIdentity=await prisma.oAuthIdentity.findUnique({where:{provider_providerSubject:{provider:'google',providerSubject:'m01b-'+runId+'-happy'}}});
  assert.equal(restored.id,happyIdentity.userId);
  assert(evidence.network.some(e=>e.path===callbackPath&&e.location==='/auth/google/complete'&&!e.activeCookie));
  evidence.cases.happy={correctDashboard:true,reload:true,wrongBrowser:303,oneExchange:true,callbackActiveCookie:false,finalActiveCookie:true};
  await a.close();await b.close();await save();

  a=await context();
  page=await begin(a,'m01b-'+runId+'-cancel');
  await page.locator('#cancel').click();
  await page.waitForURL(u=>u.pathname==='/auth/google/complete'&&u.searchParams.get('result')==='cancelled');
  assert.equal(await liveSessions('m01b-'+runId+'-cancel'),0);
  assert.equal(await activeCookie(a),undefined);
  evidence.cases.cancellation=true;
  await a.close();await save();

  a=await context();
  page=await begin(a,'m01b-'+runId+'-before');
  companion=await at(a,'/auth/google');
  await startLogin(companion,loginInput);
  assert.equal((await settled(companion)).id,passwordId);
  await startLogout(companion);
  assert.equal((await settled(companion)).status,204);
  const beforeActivation=activateCount();
  await accept(page);
  await page.waitForURL(u=>u.pathname==='/auth/google/complete');
  await page.getByRole('alert').waitFor();
  assert.equal(activateCount(),beforeActivation);
  assert.equal(await activeCookie(a),undefined);
  assert.equal(await liveSessions('m01b-'+runId+'-before'),0);
  evidence.cases.B24={logoutStatus:204,lateCallback:true,activationRequests:0,activeGoogleSessions:0};
  await a.close();await save();

  for(const kind of ['logout','switch','lost','closed']){
    const subject='m01b-'+runId+'-'+kind;
    a=await context();
    page=await begin(a,subject);
    companion=await at(a,'/auth/google');
    const pending=arm();
    await accept(page);
    const held=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('Activation not observed')),12000))]);
    await waitFor(()=>activeCookie(a));
    const activationBody=JSON.parse((await held.body).toString());
    assert(activationBody.access_token);
    secrets.add(activationBody.access_token);
    const identityBefore=await prisma.oAuthIdentity.findUnique({where:{provider_providerSubject:{provider:'google',providerSubject:subject}}});
    const original=await prisma.authSession.findFirst({where:{userId:identityBefore.userId,revokedAt:null}});
    assert(original?.browserIntentId);
    assert.equal(await liveSessions(subject),1);
    if(kind==='logout')await startLogout(companion);
    else await startLogin(companion,{...loginInput,password:kind==='switch'?loginInput.password:'deliberately-wrong'});
    await waitFor(()=>companion.evaluate(()=>!localStorage.getItem('acadboost:google-attempt')));
    if(kind==='lost')held.lose();
    else if(kind==='closed')await page.close();
    else held.release();
    const newer=await settled(companion);
    if(kind==='logout'||kind==='switch'){
      assert.equal(await liveSessions(subject),0);
      if(kind==='switch')assert.equal(newer.id,passwordId);
      evidence.cases[kind==='logout'?'B25':'B26']={newerStatus:newer.status,activeGoogleSessions:0,
        passwordAccountPreserved:kind==='switch'};
    }else{
      assert.equal(newer.status,401);
      const ordinary=await a.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
      const rotated=ordinary.status()===200 ? await ordinary.json() : null;
      const me=rotated&&await a.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+rotated.access_token}});
      const identity=await prisma.oAuthIdentity.findUnique({where:{provider_providerSubject:{provider:'google',providerSubject:subject}}});
      const sameAccount=Boolean(me&&me.status()===200&&(await me.json()).id===identity.userId);
      evidence.cases[kind==='lost'?'B27':'B28']={responseHeadersAndCookieReceived:true,newerPasswordAttempt:newer.status,
        ordinaryRefreshStatus:ordinary.status(),ordinaryMeStatus:me?.status()??null,restoredStaleGoogleAccount:sameAccount,
        activeGoogleSessions:await liveSessions(subject)};
      const bearer=await a.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+activationBody.access_token}});
      const receipt=await prisma.authBrowserIntent.findUnique({where:{id:original.browserIntentId}});
      const family=await prisma.authSession.findMany({where:{tokenFamilyId:original.tokenFamilyId}});
      assert(receipt?.supersededAt,'receipt must be superseded');
      assert(family.length && family.every(row=>row.revokedAt),'every family row must be revoked');
      assert.equal(bearer.status(),401,'fenced bearer must fail');
      evidence.cases[kind==='lost'?'B27':'B28'].bearerStatus=bearer.status();
      evidence.cases[kind==='lost'?'B27':'B28'].receiptSuperseded=true;
      evidence.cases[kind==='lost'?'B27':'B28'].familyRows=family.length;
      const controlMe=await control.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+controlToken}});
      assert.equal(controlMe.status(),200,'unrelated bearer must survive');
      assert.equal((await controlMe.json()).id,passwordId);
      const controlRefresh=await control.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
      assert.equal(controlRefresh.status(),200,'unrelated refresh must survive');
      controlToken=(await controlRefresh.json()).access_token;
      evidence.cases[kind==='lost'?'B27':'B28'].unrelatedSessionPreserved=true;
      assert.equal(ordinary.status(),401,'fenced refresh must fail');
      assert.equal(await liveSessions(subject),0,'fenced Google family must have no live sessions');
      assert.equal(sameAccount,false,'superseded Google account restored');
    }
    await a.close();await save();
  }
  }
  // Deliver a stale activation cookie after a newer explicit action commits.
  // The newer action uses the HTTP contract directly because the initiating
  // tab intentionally still owns the cooperating client Web Lock.
  if (!process.env.M01B_R1_ONLY_RESTART && !process.env.M01B_R1_ONLY_BOOTSTRAP) {
  for(const method of ['password','phone','invalid','logout']){
    const succeeds=method==='password'||method==='phone';
    const label=method==='phone'?'B31-R1-phone':method==='logout'?'B32-R1-logout':succeeds?'B31-R1':'B32-R1';
    stage=label+' start';
    const subject=`m01b-${runId}-${label.toLowerCase()}`;
    a=await context();
    page=await begin(a,subject);
    let phone,code;
    if(method==='phone'){
      phone='+1202555'+String(1000+randomBytes(2).readUInt16BE()%8000);
      const requested=await a.request.post(appOrigin+'/api/v1/auth/phone/request',{data:{phone}});
      assert.equal(requested.status(),202);
      code=smsMessages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
      assert(code,'synthetic phone code must be delivered');
      secrets.add(code);
    }
    const pending=arm('headers');
    await accept(page);
    const held=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('Activation headers not observed')),12000))]);
    const activation=JSON.parse((await held.body).toString());
    secrets.add(activation.access_token);
    stage=label+' newer password';
    const path=method==='phone'?'/api/v1/auth/phone/verify':method==='logout'?'/api/v1/auth/logout':'/api/v1/auth/password/login';
    const newer=await a.request.post(appOrigin+path,{
      headers:{Origin:appOrigin,'X-Acadboost-Auth-Intent':randomUUID()},
      ...(method!=='logout' && {data:method==='phone'?{phone,code}:{identifier:loginInput.identifier,password:succeeds?loginInput.password:'deliberately-wrong'}})
    });
    assert.equal(newer.status(),method==='logout'?204:succeeds?200:401);
    const newerBody=succeeds?await newer.json():null;
    const newerCookie=await activeCookie(a);
    if(succeeds) assert(newerCookie,'newer cookie must be delivered before stale headers');
    stage=label+' release stale headers';
    await held.release();
    await waitFor(async()=>{const c=await activeCookie(a);return c && (!newerCookie || c.value!==newerCookie.value)});
    stage=label+' stale refresh';
    const staleRefresh=await a.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
    const staleBearer=await a.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+activation.access_token}});
    assert.equal(staleRefresh.status(),401);
    assert.equal(staleBearer.status(),401);
    if(succeeds){
      stage=label+' newer session';
      const isolated=await context();
      await isolated.addCookies([newerCookie]);
      const recovered=await isolated.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
      assert.equal(recovered.status(),200,'newer server session must survive stale cookie delivery');
      const token=(await recovered.json()).access_token;
      const me=await isolated.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+token}});
      assert.equal(me.status(),200);
      const recoveredUser=await me.json();
      if(method==='password') assert.equal(recoveredUser.id,passwordId);
      else {
        const identity=await prisma.phoneIdentity.findUnique({where:{phoneE164:phone}});
        assert.equal(recoveredUser.id,identity.userId);
      }
      assert(newerBody.access_token);
      await isolated.close();
    }
    stage=label+' recovery UI';
    const recoveryPage=await at(a,'/auth/google');
    assert(await recoveryPage.getByRole('link',{name:'Use password instead'}).isVisible());
    assert.equal(await liveSessions(subject),0);
    evidence.cases[label]={newerStatus:newer.status(),staleRefresh:staleRefresh.status(),staleBearer:staleBearer.status(),newerSessionSurvived:succeeds,reauthenticationOffered:true};
    await a.close();await save();
  }

  // Reload destroys the initiating realm while its activation body is held.
  a=await context();
  page=await begin(a,`m01b-${runId}-reload`);
  companion=await at(a,'/auth/google');
  {
    const pending=arm();
    await accept(page);
    const held=await pending;
    await held.body;
    await waitFor(()=>activeCookie(a));
    await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
    held.lose();
    const count=activateCount();
    const newer=await a.request.post(appOrigin+'/api/v1/auth/password/login',{
      headers:{Origin:appOrigin,'X-Acadboost-Auth-Intent':randomUUID()},
      data:{identifier:loginInput.identifier,password:'deliberately-wrong'}
    });
    assert.equal(newer.status(),401);
    const stale=await a.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
    assert.equal(stale.status(),401);
    assert.equal(activateCount(),count,'reload must not replay activation');
    evidence.cases['B30-R1']={newerStatus:newer.status(),staleRefresh:stale.status(),activationReplayed:false};
  }
  await a.close();await save();
  // Abort the initiating page and explicitly log out while the accepted
  // activation body remains undelivered, then replay its cookie once.
  a=await context();
  page=await begin(a,`m01b-${runId}-abort-logout`);
  {
    const pending=arm();
    await accept(page);
    const held=await pending;
    await held.body;
    await waitFor(()=>activeCookie(a));
    const staleCookie=await activeCookie(a);
    await page.close();
    held.lose();
    const count=activateCount();
    const logout=await a.request.post(appOrigin+'/api/v1/auth/logout',{
      headers:{Origin:appOrigin,'X-Acadboost-Auth-Intent':randomUUID()}
    });
    assert.equal(logout.status(),204);
    await a.addCookies([staleCookie]);
    const stale=await a.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
    assert.equal(stale.status(),401);
    assert.equal(activateCount(),count);
    assert.equal(await liveSessions(`m01b-${runId}-abort-logout`),0);
    evidence.cases['B30-R1-abort-logout']={logout:logout.status(),staleRefresh:stale.status(),activationReplayed:false};
  }
  await a.close();await save();
  stage='B30-R1 interrupted phone verification';
  a=await context();
  const interruptedPhoneSubject=`m01b-${runId}-abort-phone`;
  page=await begin(a,interruptedPhoneSubject);
  {
    const pending=arm();
    await accept(page);
    const held=await pending;
    const oldBearer=JSON.parse((await held.body).toString()).access_token;
    secrets.add(oldBearer);
    await waitFor(()=>activeCookie(a));
    await page.close();
    held.lose();
    const count=activateCount();
    const phone='+1202555'+String(1000+randomBytes(2).readUInt16BE()%8000);
    const newer=await a.request.post(appOrigin+'/api/v1/auth/phone/verify',{
      headers:{Origin:appOrigin,'X-Acadboost-Auth-Intent':randomUUID()},data:{phone,code:'000000'}
    });
    assert.equal(newer.status(),401);
    const stale=await a.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
    const bearer=await a.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+oldBearer}});
    assert.equal(stale.status(),401);
    assert.equal(bearer.status(),401);
    assert.equal(activateCount(),count);
    assert.equal(await liveSessions(interruptedPhoneSubject),0);
    evidence.cases['B30-R1-abort-phone']={newerStatus:401,staleRefresh:401,staleBearer:401,activationReplayed:false};
  }
  await a.close();await save();
  }
  if(process.env.M01B_R1_SKIP_RESTART || process.env.M01B_R1_ONLY_BOOTSTRAP){
    evidence.cases['B29-R1']={status:'NOT_RUN'};
  }else {
  // Terminate the owned persistent-profile browser process after activation
  // headers and verify the cookie really survives before claiming the case.
  for(let restartAttempt=0;restartAttempt<2;restartAttempt+=1) {
    stage='B29-R1 process restart';
    const profile=path.join(certDir,'persistent-profile-'+restartAttempt);
    const cookieDatabase=path.join(profile,'Default','Network','Cookies');
    scenario=`m01b-${runId}-restart-${restartAttempt}`;
    await resetBootstrapLimit();
    const pending=arm();
    const child=fork(path.join(fe,'tests/e2e/google-r1-restart-child.mjs'),
      [profile,appOrigin,fakeOrigin,process.env.M01B_R1_BROWSER],{stdio:['ignore','ignore','ignore','ipc'],detached:process.platform!=='win32'});
    restartChild=child;
    const message=new Promise((resolve,reject)=>{
      child.once('message',value=>value.type==='cookie'?resolve(value):reject(Error(value.message)));
      child.once('error',reject);
      child.once('exit',code=>reject(Error(`browser helper exited ${code} before cookie`)));
    });
    const held=await Promise.race([pending,message.then(()=>{throw Error('Cookie arrived before proxy hold') }),new Promise((_,reject)=>setTimeout(()=>reject(Error('Restart activation not observed')),30000))]);
    await held.body;
    await message;
    // A browser can batch persistent cookie writes. Keep the body held while
    // observing disk progress, then verify both cookies after the forced exit.
    const initialCookieWrite=await fs.stat(cookieDatabase).then(file=>file.mtimeMs,()=>null);
    const subsequentCookieWrite=await waitFor(async()=>{
      const current=await fs.stat(cookieDatabase).then(file=>file.mtimeMs,()=>null);
      return current!==null && current!==initialCookieWrite;
    },45000).then(()=>true,()=>false);
    const childExit=new Promise((resolve,reject)=>child.once('exit',code=>code===0?resolve():reject(Error(`Restart helper exited ${code}`))));
    child.send('crash');
    await childExit;
    restartChild=undefined;
    held.lose();
    const restarted=await chromium.launchPersistentContext(profile,{executablePath:process.env.M01B_R1_BROWSER,
      ignoreHTTPSErrors:true,headless:true,args:['--disable-background-networking','--no-first-run']});
    try{
      const recoveredCookies=await restarted.cookies(appOrigin+'/api/v1/auth/refresh');
      const persisted=recoveredCookies.some(cookie=>cookie.name===cookieName)
        && recoveredCookies.some(cookie=>cookie.name==='__Host-outpost_auth_context');
      if(!persisted) {
        evidence.cases['B29-R1']={status:'BLOCKED',browserTerminated:true,cookiePersisted:false,subsequentCookieWrite};
      } else {
      const oldBearer=JSON.parse((await held.body).toString()).access_token;
      secrets.add(oldBearer);
      const newer=await restarted.request.post(appOrigin+'/api/v1/auth/password/login',{
        headers:{Origin:appOrigin,'X-Acadboost-Auth-Intent':randomUUID()},
        data:{identifier:loginInput.identifier,password:'deliberately-wrong'}
      });
      assert.equal(newer.status(),401);
      const stale=await restarted.request.post(appOrigin+'/api/v1/auth/refresh',{headers:{Origin:appOrigin}});
      assert.equal(stale.status(),401);
      const staleMe=await restarted.request.get(appOrigin+'/api/v1/me',{headers:{Authorization:'Bearer '+oldBearer}});
      assert.equal(staleMe.status(),401);
      assert.equal(await liveSessions(scenario),0);
      evidence.cases['B29-R1']={browserTerminated:true,cookiePersisted:true,newerStatus:newer.status(),staleRefresh:stale.status(),staleBearer:staleMe.status(),activeGoogleSessions:0,attempts:restartAttempt+1};
      }
    }finally{await restarted.close();}
    await save();
    if(evidence.cases['B29-R1'].cookiePersisted) break;
  }
  if(!evidence.cases['B29-R1'].cookiePersisted) process.exitCode=1;

  }
  // Two cold bootstraps on one browser: reverse response delivery and prove
  // the selector from the overwritten cookie cannot register an intent.
  a=await context();
  page=await at(a,'/login');
  stage='B33-R1 reversed bootstrap responses';
  await resetBootstrapLimit();
  bootstrapHolds=[];
  await page.evaluate(()=>{
    window.bootstrapReceived=[];
    const start=()=>fetch('/api/v1/auth/browser-context',{method:'POST',headers:{'Content-Type':'application/json','X-Acadboost-Browser-Auth':'1'},body:'{}'})
      .then(r=>r.json()).then(result=>{window.bootstrapReceived.push(result);return result;});
    window.bootstrapResults=Promise.all([start(),start()]);
  });
  await waitFor(()=>bootstrapHolds.length===2);
  const [first,second]=bootstrapHolds;
  bootstrapHolds=null;
  second.release();
  await page.waitForFunction(()=>window.bootstrapReceived.length===1);
  const firstDelivered=await page.evaluate(()=>window.bootstrapReceived[0]);
  const acceptedAttempt=randomUUID();
  const accepted=await a.request.post(appOrigin+'/api/v1/auth/google/intent',{
    headers:{Origin:appOrigin,'X-Acadboost-Browser-Auth':'1'},
    data:{context_id:firstDelivered.context_id,attempt:acceptedAttempt}
  });
  assert.equal(accepted.status(),204);
  first.release();
  const selectors=await page.evaluate(()=>window.bootstrapResults);
  assert.notEqual(selectors[0].context_id,selectors[1].context_id);
  const authorize=await a.request.get(appOrigin+'/api/v1/auth/google/authorize?attempt='+acceptedAttempt,{
    headers:{'Sec-Fetch-Site':'same-origin'},maxRedirects:0
  });
  assert.equal(authorize.status(),401);
  const stranded=await prisma.authBrowserIntent.findUnique({
    where:{contextId_actionId:{contextId:firstDelivered.context_id,actionId:acceptedAttempt}}
  });
  assert.equal(stranded.claimedAt,null);
  assert.equal(stranded.tokenFamilyId,null);
  const wrongPortOrigin=new URL(appOrigin);
  wrongPortOrigin.port=String(Number(wrongPortOrigin.port)===65535?65534:Number(wrongPortOrigin.port)+1);
  for(const origin of [fakeOrigin,wrongPortOrigin.origin]){
    const denied=await a.request.post(appOrigin+'/api/v1/auth/google/intent',{
      headers:{Origin:origin,'X-Acadboost-Browser-Auth':'1','X-Forwarded-Host':new URL(appOrigin).host},
      data:{context_id:firstDelivered.context_id,attempt:randomUUID()}
    });
    assert.equal(denied.status(),403);
  }
  const results=[];
  for(const selector of selectors){
    const response=await a.request.post(appOrigin+'/api/v1/auth/google/intent',{
      headers:{Origin:appOrigin,'X-Acadboost-Browser-Auth':'1'},
      data:{context_id:selector.context_id,attempt:randomUUID()}
    });
    results.push(response.status());
  }
  assert.equal(results.filter(status=>status===204).length,1,'only cookie-bound selector may register');
  assert(results.some(status=>status===401||status===409));
  evidence.cases['B33-R1']={parallelBootstrap:true,reverseDelivery:true,selectorStatuses:results,
    acceptedBeforeDelayedHeader:accepted.status(),oldAuthorize:authorize.status(),oldIntentUnclaimed:true,
    foreignHostAndPortDenied:true};
  await a.close();await save();
  const logs=capture.join('');
  assert(logs.includes('request.completed'));
  assert([...secrets].every(secret=>!logs.includes(secret)),'Sensitive value in output');
  evidence.logsClean=true;
  if(process.env.M01B_R1_SKIP_RESTART || process.env.M01B_R1_ONLY_RESTART ||
    process.env.M01B_R1_ONLY_LATE || process.env.M01B_R1_ONLY_BOOTSTRAP) {
    evidence.partialRun=true;
    process.exitCode=1;
  }
  await save();
  console.log(JSON.stringify({origins:evidence.origins,cases:evidence.cases,releaseBlocked:evidence.releaseBlocked??false,logsClean:true}));
}catch(error){
  evidence.fixtureError={name:error.name,stage,detail:stage==='B29-R1 process restart'?error.message.split('\n')[0]:undefined,code:error.code,status:error.status,line:error.stack?.split('\n').find(l=>l.includes('google-r1.mjs'))?.trim()};
  console.error('HTTPS fixture failed:',evidence.fixtureError);
  process.exitCode=1;
}finally{
  if(restartChild?.connected) restartChild.send('crash');
  for(const [stream,write] of writers)stream.write=write;
  await control?.close();
  await browser?.close();
  await close(appServer);
  await close(fakeServer);
  await close(backend);
  await vite?.close();
  await valkey.close();
  await prisma?.$disconnect();
  await fs.rm(certDir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  await save();
}
