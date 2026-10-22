import { createHash } from 'node:crypto';
import { AppError } from './domain.mjs';

const loopback = hostname => ['localhost','127.0.0.1','[::1]'].includes(hostname);
function settings({env=process.env,publicUrl=env.COBUILD_PUBLIC_URL||''}={}) {
  try {
    const apiKey=(env.COBUILD_MAIL_API_KEY||'').trim(),from=(env.COBUILD_MAIL_FROM||'').trim();
    const match=/^(?:[^<>\r\n]+\s<([^<>]+)>|([^<>]+))$/.exec(from),address=match?.[1]||match?.[2]||'';
    if (!apiKey || apiKey.length>1024 || /[\r\n]/.test(apiKey) || from.length>200 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return null;
    const apiUrl=new URL(env.COBUILD_MAIL_API_URL||'https://api.resend.com/emails'),site=new URL(publicUrl);
    for(const url of [apiUrl,site]) if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||(!loopback(url.hostname)&&url.protocol!=='https:')) return null;
    if(site.pathname!=='/')return null;
    const timeout=env.COBUILD_MAIL_TIMEOUT_MS||'8000';
    if(!/^\d+$/.test(timeout)||Number(timeout)<1000||Number(timeout)>15000)return null;
    return {apiKey,from,apiUrl:apiUrl.href,publicUrl:site.origin,timeout:Number(timeout)};
  } catch { return null; }
}
export function mailStatus(options) { return {configured:Boolean(settings(options))}; }
export function mailUnavailable() { const error=new AppError('邮件服务尚未配置，暂时无法验证邮箱或找回密码，请联系部署管理员',503);error.code='MAIL_NOT_CONFIGURED';return error; }

// Resend Send Email REST API: https://resend.com/docs/api-reference/emails/send-email
// A configured transport means requests can be submitted; inbox delivery and
// ownership of a user's email are separate facts.
export function createMailer(options) {
  const config=settings(options),controllers=new Set();let closed=false;
  return {
    status:()=>({configured:Boolean(config&&!closed)}),
    close(){closed=true;for(const controller of controllers)controller.abort();},
    async send({email,purpose,token}) {
      if(!config||closed)throw mailUnavailable();
      if(!['verify-email','reset-password'].includes(purpose)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||/[\r\n]/.test(email))throw new AppError('邮件请求格式不正确');
      const verify=purpose==='verify-email',link=new URL(verify?'/verify-email':'/reset-password',config.publicUrl);
      link.hash=new URLSearchParams({token}).toString();
      const subject=verify?'共建 · 验证你的邮箱':'共建 · 重置密码';
      const text=verify?`请打开以下链接确认你拥有此邮箱，链接在24小时后失效：\n\n${link.href}\n\n如果这不是你的操作，请忽略此邮件。`:`请打开以下链接设置新密码，链接在30分钟后失效：\n\n${link.href}\n\n设置新密码后，该账号所有设备将退出登录。如果这不是你的操作，请忽略此邮件。`;
      const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),config.timeout);timer.unref?.();
      try {
        const response=await fetch(config.apiUrl,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Idempotency-Key':`cobuild-${purpose}-${createHash('sha256').update(token).digest('hex')}`},body:JSON.stringify({from:config.from,to:[email],subject,text})});
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
  };
}
