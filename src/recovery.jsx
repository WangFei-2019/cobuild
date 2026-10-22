import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Form,Input,Result} from 'antd';
import {CheckCircleOutlined,LockOutlined,MailOutlined,ProjectOutlined} from '@ant-design/icons';
import {api,isDemo} from './lib.js';
import {authHref,navigate,safeNextPath} from './router.js';
import {useFormGuard} from './form-guard.js';
import './account.css';

export default function RecoveryPage({route,session,onSession}){
 const [form]=Form.useForm(),[pending,setPending]=useState(false),[error,setError]=useState(null),[result,setResult]=useState(null);
 const alive=useRef(true),busy=useRef(false),dirty=useRef(false),token=useRef(route.token),accountId=useRef(session.user?.id||null);
 const forgot=route.kind==='forgot-password',verify=route.kind==='verify-email',next=safeNextPath(route.next),mailConfigured=session.capabilities?.mailConfigured===true;
 useEffect(()=>()=>{alive.current=false;token.current=null;},[]);
 useFormGuard(dirty,'新密码表单');
 async function submit(values={}){
  if(busy.current||isDemo||forgot&&!mailConfigured||!forgot&&!token.current)return;
  busy.current=true;setPending(true);setError(null);
  try{
   const response=await api(`/api/auth/${route.kind}`,forgot?{email:values.email}:verify?{token:token.current}:{token:token.current,password:values.password});
   if(!alive.current)return;
   dirty.current=false;form.resetFields();setResult(response);if(!forgot)token.current=null;
   if(response.session)onSession(accountId.current,response.session);
  }catch(err){if(alive.current)setError(err);}
  finally{busy.current=false;if(alive.current)setPending(false);}
 }
 const title=forgot?'找回密码':verify?'验证邮箱':'设置新密码';
 const missingToken=!forgot&&!token.current&&!result;
 const terminal=error?.code==='TOKEN_INVALID';
 const back=()=>navigate(authHref('login',next));
 return <div className="auth-page"><div className="auth-brand"><ProjectOutlined/>共建</div><Card className="auth-panel recovery-panel"><h1>{title}</h1>
  {isDemo?<><Alert type="info" showIcon title="本地演示不提供真实邮件与账号恢复" description="演示不会发送邮件、验证邮箱或更改密码。请进入正式工作区使用真实账号服务。"/><div className="recovery-actions"><Button type="primary" onClick={()=>navigate('/dashboard')}>返回演示</Button><Button onClick={()=>location.assign('./index.html')}>进入正式工作区</Button></div></>
  :result?<><Result status="success" icon={<CheckCircleOutlined/>} title={forgot?'已接收找回请求':verify?'邮箱验证已完成':'密码已重置'} subTitle={result.message}/>{forgot&&<p className="recovery-token-note">请检查收件箱与垃圾邮件。系统不会通过此回执透露邮箱是否注册，也不保证邮件已经送达。</p>}<div className="recovery-actions">{verify&&session.user?<Button type="primary" onClick={()=>navigate('/account')}>返回个人设置</Button>:<Button type="primary" onClick={back}>返回登录</Button>}{forgot&&<Button onClick={()=>{setResult(null);setError(null);}}>重新填写邮箱</Button>}</div></>
  :<>
   <p className="auth-description">{forgot?'填写注册邮箱，系统会在邮件服务可用时提供密码重置链接。':verify?'确认后验证此链接对应邮箱的归属，不会替你登录或切换当前账号。':'输入新的账号密码。成功后所有设备都需要重新登录。'}</p>
   {error&&<Alert type="error" showIcon title={terminal?'链接无效、已使用或已过期':error.message} description={terminal?'请从个人设置重新申请邮箱验证，或重新发起密码找回。':error.code==='MAIL_NOT_CONFIGURED'?'邮件服务尚未配置，无法发送。请联系工作区部署管理员。':undefined}/>}
   {missingToken?<><Alert type="warning" showIcon title="缺少有效邮件链接" description="请重新打开邮件中的完整链接。出于账号安全，链接中的令牌只在当前页面内存中使用，刷新页面后需要重新打开邮件。"/><div className="recovery-actions"><Button onClick={()=>navigate(verify&&session.user?'/account':'/forgot-password')}>{verify&&session.user?'返回个人设置':'重新找回密码'}</Button><Button onClick={back}>返回登录</Button></div></>
   :verify?<><Alert type="info" showIcon title="点击确认后才会验证" description="请确认这是你主动申请的邮箱验证链接。当前页面不会自动使用令牌。"/><Button type="primary" block icon={<MailOutlined/>} loading={pending} disabled={pending||terminal} onClick={()=>submit()}>确认验证邮箱</Button><div className="recovery-actions"><Button onClick={()=>navigate(session.user?'/account':'/login')}>稍后再验证</Button>{terminal&&<Button type="primary" onClick={()=>navigate(session.user?'/account':'/login')}>重新申请验证</Button>}</div></>
   :<>{forgot&&!mailConfigured&&<Alert type="warning" showIcon title="邮件服务尚未配置，无法发送" description="请联系工作区部署管理员。系统不会在没有邮件服务时声称已发送重置链接。"/>}<Form form={form} layout="vertical" onFinish={submit} disabled={pending} onValuesChange={(_,values)=>{if(!forgot)dirty.current=Object.values(values).some(Boolean);setError(null);}}>
    {forgot?<Form.Item name="email" label="注册邮箱" rules={[{required:true,type:'email',message:'请填写有效邮箱'}]}><Input type="email" autoComplete="email" maxLength={254} autoFocus disabled={!mailConfigured||pending}/></Form.Item>:<><Form.Item name="password" label="新密码" rules={[{required:true,message:'请填写新密码'},{min:12,message:'密码至少 12 位'}]} extra="至少 12 位，最多 256 位。"><Input.Password autoComplete="new-password" maxLength={256} autoFocus/></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={['password']} rules={[{required:true,message:'请再次填写新密码'},({getFieldValue})=>({validator:(_,value)=>!value||value===getFieldValue('password')?Promise.resolve():Promise.reject(new Error('两次填写的密码不一致'))})]}><Input.Password autoComplete="new-password" maxLength={256}/></Form.Item></>}
    <Button type="primary" htmlType="submit" block icon={forgot?<MailOutlined/>:<LockOutlined/>} loading={pending} disabled={pending||forgot&&!mailConfigured||terminal}>{forgot?'申请重置链接':'确认重置密码'}</Button>
   </Form><div className="recovery-actions"><Button onClick={back} disabled={pending}>返回登录</Button>{terminal&&<Button onClick={()=>navigate('/forgot-password')}>申请新的重置链接</Button>}</div></>}
   {!forgot&&!missingToken&&<p className="recovery-token-note">链接中的令牌已从地址栏移除，仅用于当前页面，不会写入浏览器存储。</p>}
  </>}
 </Card></div>;
}
