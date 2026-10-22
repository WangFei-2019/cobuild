import { createHash } from 'node:crypto';
import { AppError } from './domain.mjs';
import {createSMTPTransport} from './smtp-transport.mjs';

const loopback = hostname => ['localhost','127.0.0.1','[::1]'].includes(hostname);
function settings({env=process.env,publicUrl=env.COBUILD_PUBLIC_URL||''}={}) {
  try {
    const transport=env.COBUILD_MAIL_TRANSPORT||'resend',apiKey=(env.COBUILD_MAIL_API_KEY||'').trim(),from=(env.COBUILD_MAIL_FROM||env.COBUILD_MAIL_SMTP_USER||'').trim();
    const match=/^(?:[^<>\r\n]+\s<([^<>]+)>|([^<>]+))$/.exec(from),address=match?.[1]||match?.[2]||'';
    if (from.length>200 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return null;
    const site=new URL(publicUrl);
    if(site.username||site.password||site.search||site.hash||!['http:','https:'].includes(site.protocol)||(!loopback(site.hostname)&&site.protocol!=='https:')) return null;
    if(site.pathname!=='/')return null;
    const timeout=env.COBUILD_MAIL_TIMEOUT_MS||'8000';
    if(!/^\d+$/.test(timeout)||Number(timeout)<1000||Number(timeout)>15000)return null;
    if(transport==='smtp'){
      const host=(env.COBUILD_MAIL_SMTP_HOST||'smtp.qq.com').trim(),port=Number(env.COBUILD_MAIL_SMTP_PORT||'465'),user=(env.COBUILD_MAIL_SMTP_USER||'').trim(),pass=(env.COBUILD_MAIL_SMTP_PASSWORD||'').trim();
      if(!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(host)||![465,587].includes(port)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user)||!pass||pass.length>1024||/[\r\n\0]/.test(pass)||(host==='smtp.qq.com'&&address.toLowerCase()!==user.toLowerCase()))return null;
      return {transport,from,publicUrl:site.origin,timeout:Number(timeout),smtp:{host,port,secure:port===465,requireTLS:true,auth:{user,pass},connectionTimeout:Number(timeout),greetingTimeout:Number(timeout),socketTimeout:Number(timeout),tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:host}}};
    }
    if(transport!=='resend'||!apiKey||apiKey.length>1024||/[\r\n]/.test(apiKey))return null;
    const apiUrl=new URL(env.COBUILD_MAIL_API_URL||'https://api.resend.com/emails');
    if(apiUrl.username||apiUrl.password||apiUrl.search||apiUrl.hash||!['http:','https:'].includes(apiUrl.protocol)||(!loopback(apiUrl.hostname)&&apiUrl.protocol!=='https:'))return null;
    return {transport,apiKey,from,apiUrl:apiUrl.href,publicUrl:site.origin,timeout:Number(timeout)};
  } catch { return null; }
}
export function mailStatus(options) { return {configured:Boolean(settings(options))}; }
export function mailDiagnostics({env=process.env,publicUrl=env.COBUILD_PUBLIC_URL||''}={}) {
  const configured=Boolean(settings({env,publicUrl})),smtp=env.COBUILD_MAIL_TRANSPORT==='smtp';
  const checks=[
    {key:'sender',label:'发件人地址',ready:Boolean((env.COBUILD_MAIL_FROM||env.COBUILD_MAIL_SMTP_USER||'').trim()),variable:'COBUILD_MAIL_FROM'},
    {key:'credential',label:smtp?'服务端 SMTP 授权码':'服务端发送凭据',ready:Boolean((env[smtp?'COBUILD_MAIL_SMTP_PASSWORD':'COBUILD_MAIL_API_KEY']||'').trim()),variable:smtp?'COBUILD_MAIL_SMTP_PASSWORD_FILE':'COBUILD_MAIL_API_KEY_FILE'},
    {key:'origin',label:'账号链接公开地址',ready:Boolean(publicUrl),variable:'COBUILD_PUBLIC_URL'},
    {key:'transport',label:smtp?'SMTP 地址、TLS 与超时格式':'接口、地址与超时格式',ready:configured,variable:smtp?'COBUILD_MAIL_SMTP_HOST / COBUILD_MAIL_SMTP_PORT':'COBUILD_MAIL_API_URL / COBUILD_MAIL_TIMEOUT_MS'}
  ];
  return {configured,transport:smtp?'smtp':'resend',provider:smtp?'SMTP · QQ / TLS 邮件服务':'Resend 兼容邮件接口',checks,deliveryVerified:false,
    message:configured?'配置格式通过；发送测试邮件后，请在本人邮箱确认实际到达。':'补齐服务端配置并重启后，可在此发送测试邮件。'};
}
export function mailUnavailable() { const error=new AppError('邮件服务尚未配置，暂时无法验证邮箱或找回密码，请联系部署管理员',503);error.code='MAIL_NOT_CONFIGURED';return error; }

// Resend Send Email REST API: https://resend.com/docs/api-reference/emails/send-email
// A configured transport means requests can be submitted; inbox delivery and
// ownership of a user's email are separate facts.
export function createMailer(options) {
  const config=settings(options),controllers=new Set();let closed=false;
  async function deliver({email,subject,text,idempotency}) {
    if(!config||closed)throw mailUnavailable();
    if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email)||/[\r\n]/.test(email))throw new AppError('收件地址格式不正确');
    const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),config.timeout);timer.unref?.();
    try {
      if(config.transport==='smtp'){
        const transport=(options?.smtpFactory||createSMTPTransport)(config.smtp);let onAbort;
        try{
          const timeout=new Promise((_,reject)=>{onAbort=()=>{transport.close();reject(new Error('SMTP timeout'));};controller.signal.addEventListener('abort',onAbort,{once:true});});
          const info=await Promise.race([transport.sendMail({from:config.from,to:email,subject,text,messageId:`<${idempotency}@cobuild.invalid>`,disableFileAccess:true,disableUrlAccess:true}),timeout]);
          if(!Array.isArray(info.accepted)||!info.accepted.some(value=>String(value).toLowerCase()===email.toLowerCase()))throw new Error('SMTP recipient rejected');
          return {accepted:true};
        }finally{if(onAbort)controller.signal.removeEventListener('abort',onAbort);transport.close();}
      }
      const response=await fetch(config.apiUrl,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Idempotency-Key':idempotency},body:JSON.stringify({from:config.from,to:[email],subject,text})});
      if(!response.ok) {await response.body?.cancel();throw new Error('provider rejected');}
      let size=0,body='';const decoder=new TextDecoder();
      for await(const chunk of response.body){size+=chunk.length;if(size>16384){controller.abort();throw new Error('provider response too large');}body+=decoder.decode(chunk,{stream:true});}
      body+=decoder.decode();const result=JSON.parse(body);
      if(typeof result.id!=='string'||!result.id||result.id.length>200)throw new Error('provider acknowledgement missing');
      return {accepted:true};
    } catch {
      const error=new AppError('邮件服务暂时不可用，请稍后再试',502);error.code='MAIL_DELIVERY_FAILED';throw error;
    } finally {clearTimeout(timer);controllers.delete(controller);}
  }
  return {
    status:()=>({configured:Boolean(config&&!closed)}),
    diagnostics:()=>({...mailDiagnostics(options),configured:Boolean(config&&!closed)}),
    close(){closed=true;for(const controller of controllers)controller.abort();},
    async sendTest({email,requestId}) {
      if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))throw new AppError('测试邮件请求标识不正确');
      return deliver({email,subject:'共建 · 邮件连接测试',text:'这是一封由工作区管理员主动发送到本人邮箱的连接测试邮件。\n\n收到此邮件表示本次测试已到达你的邮箱；它不会验证账号邮箱，也不会修改密码或项目。\n\n'+(config?.publicUrl||''),idempotency:'cobuild-test-'+requestId});
    },
    async send({email,purpose,token}) {
      if(!config||closed)throw mailUnavailable();
      if(!['verify-email','reset-password'].includes(purpose)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||/[\r\n]/.test(email))throw new AppError('邮件请求格式不正确');
      const verify=purpose==='verify-email',link=new URL(verify?'/verify-email':'/reset-password',config.publicUrl);
      link.hash=new URLSearchParams({token}).toString();
      const subject=verify?'共建 · 验证你的邮箱':'共建 · 重置密码';
      const text=verify?`请打开以下链接确认你拥有此邮箱，链接在24小时后失效：\n\n${link.href}\n\n如果这不是你的操作，请忽略此邮件。`:`请打开以下链接设置新密码，链接在30分钟后失效：\n\n${link.href}\n\n设置新密码后，该账号所有设备将退出登录。如果这不是你的操作，请忽略此邮件。`;
      return deliver({email,subject,text,idempotency:`cobuild-${purpose}-${createHash('sha256').update(token).digest('hex')}`});
    }
  };
}
