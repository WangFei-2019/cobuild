import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Alert,Avatar,Button,Card,Form,Input,Space,Tag} from 'antd';
import {ArrowRightOutlined,CheckCircleOutlined,LockOutlined,MailOutlined,RobotOutlined,SaveOutlined,UserOutlined} from '@ant-design/icons';
import {api,avatarInitial,contrastColor,isDemo,safeColor,useResource} from './lib.js';
import {navigate} from './router.js';
import {PageHeading,ResourceState} from './pages.jsx';
import ColorField,{colorRules} from './color-field.jsx';
import {useFormGuard} from './form-guard.js';
import {PersonalAISettings} from './ai-service-settings.jsx';
import './account.css';

const sections=[
 {key:'profile',label:'个人资料',description:'昵称、简介与个人标识',icon:<UserOutlined/>},
 {key:'security',label:'账号安全',description:'邮箱验证与登录密码',icon:<LockOutlined/>},
 {key:'ai',label:'AI 服务',description:'个人模型与平台额度',icon:<RobotOutlined/>}
];

export default function AccountPage({section='profile',session,onSession,onChanged}){
 const resource=useResource('/api/account');
 if(!resource.value||resource.error)return <ResourceState {...resource} onRetry={resource.refresh}/>;
 return <AccountEditor key={resource.value.account.id} section={section} initial={resource.value} session={session} onSession={onSession} onChanged={onChanged}/>;
}

function AccountEditor({section,initial,session,onSession,onChanged}){
 const [account,setAccount]=useState(initial.account),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const activeSection=sections.find(item=>item.key===section)||sections[0];
 function profileSaved(result){
  if(!alive.current)return;
  setAccount(result.account);
  if(result.session)onSession(session.user.id,result.session);
  onChanged?.();
 }
 function passwordSaved(result){if(alive.current)onSession(session.user.id,result.session);}
 function emailVerified(){if(alive.current)setAccount(current=>({...current,emailVerified:true}));}
 return <section className="account-page"><div className="page-eyebrow"><UserOutlined/> 我的账号</div><PageHeading title="个人设置" description="管理你的协作身份、安全与 AI 服务。"/>
  <div className="account-identity"><Avatar size={52} style={{background:safeColor(account.color),color:contrastColor(account.color)}}>{avatarInitial(account)}</Avatar><div><h2>{account.name}</h2><Space wrap><Tag>{isDemo?'本地体验身份':account.workspaceRole==='admin'?'工作区管理员':'工作区成员'}</Tag><span>{isDemo?'资料仅保存于当前浏览器':account.email}</span></Space></div><Button type="text" onClick={()=>navigate(`/people/${encodeURIComponent(account.personId)}`)}>查看协作档案<ArrowRightOutlined/></Button></div>
  <div className="account-settings-layout"><nav className="account-section-nav" aria-label="个人设置分区">{sections.map(item=><button key={item.key} type="button" className={`account-section-link${activeSection.key===item.key?' active':''}`} aria-current={activeSection.key===item.key?'page':undefined} onClick={()=>navigate(`/account/${item.key}`)}><span className="account-section-icon">{item.icon}</span><span className="account-section-text"><strong>{item.label}</strong><small>{item.description}</small></span><ArrowRightOutlined className="account-section-arrow"/></button>)}</nav>
   <div className="account-section-content" key={activeSection.key}>
    {activeSection.key==='profile'&&<ProfileEditor account={account} onSaved={profileSaved}/>}
    {activeSection.key==='security'&&<SecurityEditor account={account} mailConfigured={initial.capabilities?.mailConfigured===true&&!isDemo} onPasswordSaved={passwordSaved} onEmailVerified={emailVerified}/>}
    {activeSection.key==='ai'&&(isDemo?<Card className="account-card" title={<Space><RobotOutlined/>AI 服务</Space>}><Alert type="info" showIcon title="演示不连接真实模型，也不保存 API Key" description="当前浏览器可体验内置规划示例及外部 AI 上下文导出。配置个人 DeepSeek、使用平台额度和真实模型调用，需要进入正式工作区。"/></Card>:<PersonalAISettings/>)}
   </div>
  </div>
 </section>;
}

function ProfileEditor({account,onSaved}){
 const [form]=Form.useForm(),[pending,setPending]=useState(false),[error,setError]=useState(null),[nameError,setNameError]=useState(null),[edited,setEdited]=useState(false);
 const alive=useRef(true),busy=useRef(false),dirty=useRef(false),baseline=useRef(account);const {message}=AntApp.useApp();
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useFormGuard(dirty,'个人资料');
 function changed(changedValues,values){dirty.current=['name','bio','color'].some(key=>(values[key]||'')!==(baseline.current[key]||''));setEdited(dirty.current);setError(null);if('name'in changedValues){setNameError(null);form.setFields([{name:'name',errors:[]}]);}}
 async function save(values){
  if(busy.current)return;const patch=Object.fromEntries(Object.entries(values).filter(([key,value])=>(value||'')!==(baseline.current[key]||'')));if(!Object.keys(patch).length)return;
  busy.current=true;setPending(true);setError(null);setNameError(null);
  try{const result=await api('/api/account',patch,{method:'PATCH'});onSaved(result);if(!alive.current)return;baseline.current=result.account;form.setFieldsValue({name:result.account.name,bio:result.account.bio||'',color:result.account.color});dirty.current=false;setEdited(false);message.success(isDemo?'资料已保存在当前浏览器':'个人资料已更新，项目中的姓名也会同步');}
  catch(err){if(!alive.current)return;if(err.code==='NAME_TAKEN'){setNameError('该昵称已被占用');form.setFields([{name:'name',errors:['该昵称已被占用']}]);form.scrollToField('name',{focus:true});}else setError(err);}
  finally{busy.current=false;if(alive.current)setPending(false);}
 }
 return <Card title="个人资料" className="account-card"><p className="account-muted">这些资料用于项目中的成员展示和协作档案。</p>{error&&<Alert className="account-error" type="error" showIcon title={error.message}/>}<Form form={form} layout="vertical" initialValues={{name:account.name,bio:account.bio||'',color:account.color}} onValuesChange={changed} onFinish={save} disabled={pending}><Form.Item label="昵称" name="name" rules={[{required:true,whitespace:true,message:'请填写昵称'}]} validateStatus={nameError?'error':undefined} help={nameError} extra="用于各项目显示，不能与其他已注册账号的昵称重复。"><Input autoComplete="nickname" maxLength={40}/></Form.Item><Form.Item label="个人简介" name="bio"><Input.TextArea maxLength={500} rows={4} showCount placeholder="简单介绍你的经验或擅长的方向"/></Form.Item><Form.Item label="个人标识色" name="color" rules={colorRules}><ColorField disabled={pending}/></Form.Item><div className="account-form-actions"><Button type="primary" htmlType="submit" icon={<SaveOutlined/>} loading={pending} disabled={!edited||pending}>保存资料</Button>{edited&&<span className="account-unsaved">有未保存的修改</span>}</div></Form></Card>;
}

function SecurityEditor({account,mailConfigured,onPasswordSaved,onEmailVerified}){
 const [form]=Form.useForm(),[pending,setPending]=useState(null),[error,setError]=useState(null),[mailResult,setMailResult]=useState(null),[passwordError,setPasswordError]=useState(null);
 const alive=useRef(true),busy=useRef(false),dirty=useRef(false);const {message}=AntApp.useApp();
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useFormGuard(dirty,'账号安全');
 function changed(changedValues,values){dirty.current=Object.values(values).some(Boolean);setError(null);if('currentPassword'in changedValues){setPasswordError(null);form.setFields([{name:'currentPassword',errors:[]}]);}}
 async function changePassword(values){
  if(busy.current)return;busy.current=true;setPending('password');setError(null);setPasswordError(null);
  try{const result=await api('/api/account/password',{currentPassword:values.currentPassword,newPassword:values.newPassword});dirty.current=false;onPasswordSaved(result);if(!alive.current)return;form.resetFields();message.success(result.message||'密码已修改，请重新登录');navigate('/login',{replace:true});}
  catch(err){if(!alive.current)return;if(err.code==='CURRENT_PASSWORD_INVALID'){setPasswordError('当前密码不正确');form.setFields([{name:'currentPassword',errors:['当前密码不正确']}]);}else setError(err);}
  finally{busy.current=false;if(alive.current)setPending(null);}
 }
 async function sendVerification(){
  if(busy.current||!mailConfigured||account.emailVerified)return;busy.current=true;setPending('verify');setError(null);setMailResult(null);
  try{const result=await api('/api/account/email-verification',{});if(result.alreadyVerified)onEmailVerified();if(alive.current)setMailResult(result.message);}
  catch(err){if(alive.current)setError(err);}
  finally{busy.current=false;if(alive.current)setPending(null);}
 }
 return <div className="account-security">{error&&<Alert className="account-error" type="error" showIcon title={error.message} description={error.code==='MAIL_NOT_CONFIGURED'?'工作区尚未配置邮件服务，无法发送验证邮件。其他协作功能可继续使用。':undefined}/>}
  <Card title={<span><MailOutlined/> 邮箱与验证</span>} className="account-card"><div className="account-email-line"><strong>{isDemo?'演示不提供真实邮箱':account.email}</strong>{!isDemo&&<Tag color={account.emailVerified?'success':'default'}>{account.emailVerified?'已验证':'未验证'}</Tag>}</div>{isDemo?<Alert type="info" showIcon title="本地演示不发送邮件" description="真实账号、邮件验证与密码恢复需连接正式工作区服务。"/>:account.emailVerified?<p className="account-muted"><CheckCircleOutlined/> 你的邮箱已完成验证。</p>:<><p className="account-muted">通过邮箱中的验证链接确认归属。此处不会自动修改邮箱地址。</p>{!mailConfigured&&<Alert type="warning" showIcon title="邮件服务尚未配置，无法发送" description="请联系工作区部署管理员配置邮件服务，之后可回来发送验证链接。"/>}<Button style={{marginTop:14}} icon={<MailOutlined/>} loading={pending==='verify'} disabled={!mailConfigured||Boolean(pending)} onClick={sendVerification}>发送验证邮件</Button>{mailResult&&<Alert style={{marginTop:14}} type="info" showIcon title={mailResult} description="邮箱状态在你打开邮件并确认验证后更新。"/>}</>}</Card>
  <Card title={<span><LockOutlined/> 修改密码</span>} className="account-card">{isDemo?<p className="account-muted">此演示没有真实密码与登录会话，不提供密码修改。</p>:<><p className="account-muted">修改成功后会退出所有设备，请使用新密码重新登录。密码输入不会保存为草稿。</p><Form form={form} preserve={false} layout="vertical" onValuesChange={changed} onFinish={changePassword} disabled={Boolean(pending)}><Form.Item name="currentPassword" label="当前密码" rules={[{required:true,message:'请填写当前密码'}]} validateStatus={passwordError?'error':undefined} help={passwordError}><Input.Password maxLength={256} autoComplete="current-password"/></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{required:true,message:'请填写新密码'},{min:12,message:'密码至少 12 位'}]} extra="至少 12 位，最多 256 位。"><Input.Password maxLength={256} autoComplete="new-password"/></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{required:true,message:'请再次填写新密码'},({getFieldValue})=>({validator:(_,value)=>!value||value===getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次填写的密码不一致'))})]}><Input.Password maxLength={256} autoComplete="new-password"/></Form.Item><Button htmlType="submit" icon={<LockOutlined/>} loading={pending==='password'} disabled={Boolean(pending)}>更新密码并重新登录</Button></Form></>}</Card>
 </div>;
}
