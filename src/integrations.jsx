import React,{useState} from 'react';
import {Alert,App as AntApp,Button,Card,Collapse,Space,Tag} from 'antd';
import {MailOutlined,ReloadOutlined} from '@ant-design/icons';
import {api,useResource} from './lib.js';
import './integrations.css';

export default function MailIntegration(){
 const resource=useResource('/api/admin/integrations'),[sending,setSending]=useState(false),[receipt,setReceipt]=useState(null),[error,setError]=useState('');const {message}=AntApp.useApp();
 async function send(){if(sending)return;setSending(true);setError('');setReceipt(null);try{const result=await api('/api/admin/mail/test',{});setReceipt(result);message.success('测试邮件已提交，请检查本人收件箱');}catch(err){setError(err.message);}finally{setSending(false);}}
 const mail=resource.value?.mail;
 return <Card title={<Space><MailOutlined/>账号邮件服务</Space>} className="settings-card mail-integration">
 <Alert showIcon type={mail?.configured?'success':'warning'} title={resource.loading?'正在核对服务端配置…':mail?.configured?'配置格式已通过，待确认实际送达':'邮件连接待配置'} description={resource.error?.message||mail?.message||'邮箱验证和密码找回需要可用的邮件服务。'}/>
 {mail&&<div className="mail-connection-checks">{mail.checks.map(check=><div key={check.key}><span>{check.label}</span><Tag color={check.ready?'success':'default'}>{check.ready?'已就绪':'待配置'}</Tag></div>)}</div>}
 <Space wrap><Button icon={<ReloadOutlined/>} onClick={()=>{setError('');resource.refresh();}} disabled={sending} loading={resource.loading}>重新检查</Button><Button type="primary" icon={<MailOutlined/>} onClick={send} loading={sending} disabled={!mail?.configured||resource.loading}>发送测试邮件到本人</Button></Space>
 <p className="mail-connection-note">仅向当前管理员账号邮箱发送。服务端接收成功与收件箱实际到达分别核对；测试不会验证邮箱或修改密码。</p>
 {error&&<Alert style={{marginTop:12}} type="error" showIcon title="测试未完成" description={error}/>}
 {receipt&&<Alert style={{marginTop:12}} type="info" showIcon title="邮件服务已接收请求" description={receipt.message}/>}
 <Collapse ghost items={[{key:'setup',label:'部署配置与收发验收步骤',children:<div className="mail-setup-instructions"><ol><li>QQ 邮箱先开启 SMTP 并取得专用授权码；Resend 则先验证发件域名。</li><li>在服务器私有配置中指定发送凭据文件及下列参数，重启共建服务。</li><li>重新检查并向本人发送测试邮件，核对收件箱或垃圾邮件夹。</li><li>用测试账号完成邮箱验证和找回密码，确认链接、过期和重新登录流程。</li></ol><h4>QQ 邮箱 · 平台统一发送</h4><pre>COBUILD_MAIL_TRANSPORT=smtp{ '\n' }COBUILD_MAIL_SMTP_HOST=smtp.qq.com{ '\n' }COBUILD_MAIL_SMTP_PORT=465{ '\n' }COBUILD_MAIL_SMTP_USER=平台发件邮箱{ '\n' }COBUILD_MAIL_SMTP_PASSWORD_FILE=/etc/cobuild/mail-smtp-password{ '\n' }COBUILD_MAIL_FROM=共建 &lt;同一平台发件邮箱&gt;</pre><h4>Resend · 已验证域名</h4><pre>COBUILD_MAIL_TRANSPORT=resend{ '\n' }COBUILD_MAIL_API_KEY_FILE=/etc/cobuild/mail-api-key{ '\n' }COBUILD_MAIL_FROM=共建 &lt;noreply@你的已验证域名&gt;{ '\n' }COBUILD_MAIL_API_URL=https://api.resend.com/emails{ '\n' }COBUILD_PUBLIC_URL=当前工作区的 HTTPS 根地址</pre><p>凭据只由部署管理员在服务器维护，此页面不会接收或显示密钥。收件用户无需配置邮件服务。支持 QQ SMTP（TLS）及 Resend 兼容接口，QQ 使用 SMTP 授权码，不使用登录密码。</p><a href="https://resend.com/docs/api-reference/emails/send-email" target="_blank" rel="noreferrer">查看邮件接口文档</a></div>} ]}/>
 </Card>;
}
