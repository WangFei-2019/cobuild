import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Alert,Avatar,Button,Card,Form,Input,Space,Tag} from 'antd';
import {ArrowRightOutlined,CheckCircleOutlined,LockOutlined,MailOutlined,SaveOutlined,UserOutlined} from '@ant-design/icons';
import {api,avatarInitial,contrastColor,isDemo,safeColor,useResource} from './lib.js';
import {navigate} from './router.js';
import {PageHeading,ResourceState} from './pages.jsx';
import ColorField,{colorRules} from './color-field.jsx';
import {useFormGuard} from './form-guard.js';
import './account.css';

export default function AccountPage({session,onSession,onChanged}){
 const resource=useResource('/api/account');
 if(!resource.value||resource.error)return <ResourceState {...resource} onRetry={resource.refresh}/>;
 return <AccountEditor key={resource.value.account.id} initial={resource.value} session={session} onSession={onSession} onChanged={onChanged}/>;
}

function AccountEditor({initial,session,onSession,onChanged}){
 const {message,modal}=AntApp.useApp(),[profile]=Form.useForm(),[password]=Form.useForm();
 const [account,setAccount]=useState(initial.account),[pending,setPending]=useState(null),[error,setError]=useState(null),[mailResult,setMailResult]=useState(null),[nameError,setNameError]=useState(null),[passwordError,setPasswordError]=useState(null),[profileEdited,setProfileEdited]=useState(false);
 const alive=useRef(true),busy=useRef(null),profileDirty=useRef(false),passwordDirty=useRef(false),dirty=useRef(false),baseline=useRef(initial.account);
 useEffect(()=>()=>{alive.current=false;},[]);
 useFormGuard(dirty,'个人设置');
 const mailConfigured=initial.capabilities?.mailConfigured===true&&!isDemo;
 function syncDirty(){dirty.current=profileDirty.current||passwordDirty.current;}
 function profileChanged(changed,values){profileDirty.current=['name','bio','color'].some(key=>(values[key]||'')!==(baseline.current[key]||''));setProfileEdited(profileDirty.current);syncDirty();setError(null);if('name'in changed){setNameError(null);profile.setFields([{name:'name',errors:[]}]);}}
 function passwordChanged(changed,values){passwordDirty.current=Object.values(values).some(Boolean);syncDirty();setError(null);if('currentPassword'in changed){setPasswordError(null);password.setFields([{name:'currentPassword',errors:[]}]);}}
 async function saveProfile(values){
  if(busy.current)return;const patch=Object.fromEntries(Object.entries(values).filter(([key,value])=>(value||'')!==(baseline.current[key]||'')));if(!Object.keys(patch).length)return;
  busy.current='profile';setPending('profile');setError(null);setNameError(null);
  try{const result=await api('/api/account',patch,{method:'PATCH'});if(!alive.current)return;baseline.current=result.account;setAccount(result.account);profile.setFieldsValue({name:result.account.name,bio:result.account.bio,color:result.account.color});profileDirty.current=false;setProfileEdited(false);syncDirty();if(result.session)onSession(session.user.id,result.session);onChanged?.();message.success(isDemo?'资料已保存在当前浏览器':'个人资料已更新，项目中的姓名也会同步');}
  catch(err){if(!alive.current)return;if(err.code==='NAME_TAKEN'){setNameError('该昵称已被占用');profile.setFields([{name:'name',errors:['该昵称已被占用']}]);profile.scrollToField('name',{focus:true});}else setError(err);}
  finally{busy.current=null;if(alive.current)setPending(null);}
 }
 async function changePassword(values){
  if(busy.current)return;
  if(profileDirty.current&&!await new Promise(resolve=>modal.confirm({title:'修改密码后需要重新登录',content:'个人资料还有未保存的修改。继续后这些输入将被放弃；也可以取消并先保存资料。',okText:'继续修改密码',cancelText:'先保存资料',onOk:()=>resolve(true),onCancel:()=>resolve(false)})))return;
  if(!alive.current||busy.current)return;busy.current='password';setPending('password');setError(null);setPasswordError(null);
  try{const result=await api('/api/account/password',{currentPassword:values.currentPassword,newPassword:values.newPassword});if(!alive.current)return;dirty.current=false;profileDirty.current=false;passwordDirty.current=false;password.resetFields();message.success(result.message||'密码已修改，请重新登录');onSession(session.user.id,result.session);navigate('/login',{replace:true});}
  catch(err){if(!alive.current)return;if(err.code==='CURRENT_PASSWORD_INVALID'){setPasswordError('当前密码不正确');password.setFields([{name:'currentPassword',errors:['当前密码不正确']}]);}else setError(err);}
  finally{busy.current=null;if(alive.current)setPending(null);}
 }
 async function sendVerification(){
  if(busy.current||!mailConfigured||account.emailVerified)return;busy.current='verify';setPending('verify');setError(null);setMailResult(null);
  try{const result=await api('/api/account/email-verification',{});if(!alive.current)return;setMailResult(result.message);if(result.alreadyVerified)setAccount(current=>({...current,emailVerified:true}));}
  catch(err){if(alive.current)setError(err);}
  finally{busy.current=null;if(alive.current)setPending(null);}
 }
 return <section className="account-page"><div className="page-eyebrow"><UserOutlined/> 我的账号</div><PageHeading title="个人设置" description="维护协作资料与账号安全。工作区模型配置由管理员单独维护。"/>
  <div className="account-identity"><Avatar size={58} style={{background:safeColor(account.color),color:contrastColor(account.color)}}>{avatarInitial(account)}</Avatar><div><h2>{account.name}</h2><Space wrap><Tag>{isDemo?'本地体验身份':account.workspaceRole==='admin'?'工作区管理员':'工作区成员'}</Tag><span>{isDemo?'资料仅保存于当前浏览器':account.email}</span></Space></div><Button type="text" onClick={()=>navigate(`/people/${encodeURIComponent(account.personId)}`)}>查看协作档案<ArrowRightOutlined/></Button></div>
  {error&&<Alert className="account-error" type="error" showIcon title={error.message} description={error.code==='MAIL_NOT_CONFIGURED'?'工作区尚未配置邮件服务，无法发送验证邮件。其他协作功能可继续使用。':undefined}/>}
  <div className="account-columns"><Card title="协作资料" className="account-card"><Form form={profile} layout="vertical" initialValues={{name:account.name,bio:account.bio||'',color:account.color}} onValuesChange={profileChanged} onFinish={saveProfile} disabled={Boolean(pending)}><Form.Item label="昵称" name="name" rules={[{required:true,whitespace:true,message:'请填写昵称'}]} validateStatus={nameError?'error':undefined} help={nameError} extra="用于各项目显示，不能与其他已注册账号的昵称重复。"><Input autoComplete="nickname" maxLength={40}/></Form.Item><Form.Item label="个人简介" name="bio"><Input.TextArea maxLength={500} rows={3} showCount placeholder="简单介绍你的经验或擅长的方向"/></Form.Item><Form.Item label="个人标识色" name="color" rules={colorRules}><ColorField disabled={Boolean(pending)}/></Form.Item><Button type="primary" htmlType="submit" icon={<SaveOutlined/>} loading={pending==='profile'} disabled={!profileEdited||Boolean(pending)}>保存资料</Button>{profileEdited&&<span className="account-unsaved">有未保存的修改</span>}</Form></Card>
  <div className="account-security"><Card title={<span><MailOutlined/> 邮箱与验证</span>} className="account-card"><div className="account-email-line"><strong>{isDemo?'演示不提供真实邮箱':account.email}</strong>{!isDemo&&<Tag color={account.emailVerified?'success':'default'}>{account.emailVerified?'已验证':'未验证'}</Tag>}</div>{isDemo?<Alert type="info" showIcon title="本地演示不发送邮件" description="真实账号、邮件验证与密码恢复需连接正式工作区服务。"/>:account.emailVerified?<p className="account-muted"><CheckCircleOutlined/> 你的邮箱已完成验证。</p>:<><p className="account-muted">通过邮箱中的验证链接确认归属。此处不会自动修改邮箱地址。</p>{!mailConfigured&&<Alert type="warning" showIcon title="邮件服务尚未配置，无法发送" description="请联系工作区部署管理员配置邮件服务，之后可回来发送验证链接。"/>}<Button style={{marginTop:14}} icon={<MailOutlined/>} loading={pending==='verify'} disabled={!mailConfigured||Boolean(pending)} onClick={sendVerification}>发送验证邮件</Button>{mailResult&&<Alert style={{marginTop:14}} type="info" showIcon title={mailResult} description="邮箱状态在你打开邮件并确认验证后更新。"/>}</>}</Card>
  <Card title={<span><LockOutlined/> 修改密码</span>} className="account-card">{isDemo?<p className="account-muted">此演示没有真实密码与登录会话，不提供密码修改。</p>:<><p className="account-muted">修改成功后会退出所有设备，请使用新密码重新登录。</p><Form form={password} layout="vertical" onValuesChange={passwordChanged} onFinish={changePassword} disabled={Boolean(pending)}><Form.Item name="currentPassword" label="当前密码" rules={[{required:true,message:'请填写当前密码'}]} validateStatus={passwordError?'error':undefined} help={passwordError}><Input.Password maxLength={256} autoComplete="current-password"/></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{required:true,message:'请填写新密码'},{min:12,message:'密码至少 12 位'}]} extra="至少 12 位，最多 256 位。"><Input.Password maxLength={256} autoComplete="new-password"/></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{required:true,message:'请再次填写新密码'},({getFieldValue})=>({validator:(_,value)=>!value||value===getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次填写的密码不一致'))})]}><Input.Password maxLength={256} autoComplete="new-password"/></Form.Item><Button htmlType="submit" icon={<LockOutlined/>} loading={pending==='password'} disabled={Boolean(pending)}>更新密码并重新登录</Button></Form></>}</Card></div></div>
 </section>;
}
