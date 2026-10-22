import React,{useEffect,useRef,useState} from 'react';
import {Alert,App as AntApp,Button,Card,Form,Input,InputNumber,Modal,Select,Space,Switch,Table,Tag} from 'antd';
import {ExperimentOutlined,ReloadOutlined,RobotOutlined,SaveOutlined} from '@ant-design/icons';
import {api,useResource} from './lib.js';
import {useFormGuard} from './form-guard.js';
import './ai-service-settings.css';

export function PersonalAISettings(){
 const resource=useResource('/api/account/ai');
 if(!resource.value)return <Card className="account-card" title="我的 AI 服务"><Alert showIcon type={resource.error?'warning':'info'} title={resource.error?.message||'正在读取模型服务…'} action={<Button onClick={resource.refresh}>重试</Button>}/></Card>;
 return <PersonalAIEditor key={resource.value.personal.revision} initial={resource.value} onSaved={resource.refresh}/>;
}
function PersonalAIEditor({initial,onSaved}){
 const [form]=Form.useForm(),[pending,setPending]=useState(null),[error,setError]=useState(''),[testResult,setTestResult]=useState(null),[edited,setEdited]=useState(false);const dirty=useRef(false),busy=useRef(false),alive=useRef(true),confirmation=useRef(null);const {message,modal}=AntApp.useApp();useFormGuard(dirty,'个人模型设置');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;confirmation.current?.destroy();};},[]);
 async function save(values){if(busy.current)return;busy.current=true;setPending('save');setError('');try{await api('/api/account/ai',{...values,expectedRevision:initial.personal.revision});if(!alive.current)return;dirty.current=false;setEdited(false);form.setFieldValue('apiKey','');message.success('个人模型配置已保存');onSaved();}catch(err){if(alive.current)setError(err.message);}finally{busy.current=false;if(alive.current)setPending(null);}}
 async function probe(){if(busy.current)return;busy.current=true;setPending('test');setError('');setTestResult(null);try{const result=await api('/api/account/ai/test',{});if(!alive.current)return;setTestResult(result);onSaved();}catch(err){if(alive.current)setError(err.message);}finally{busy.current=false;if(alive.current)setPending(null);}}
 function changed(_,values){dirty.current=values.enabled!==initial.personal.enabled||values.model!==initial.personal.model||Boolean(values.apiKey);setEdited(dirty.current);setError('');}
 function clear(){
  if(busy.current)return;busy.current=true;setPending('clear-confirm');
  confirmation.current=modal.confirm({title:'移除自己的模型凭据？',content:`服务器保存的个人 Key 将被清除。后续可重新配置；如已获平台额度，将使用平台服务。${dirty.current?'移除成功后，当前未保存的模型输入也会被放弃。':''}`,okText:'移除凭据',cancelText:'保留',okButtonProps:{danger:true},onCancel:()=>{confirmation.current=null;busy.current=false;if(alive.current)setPending(null);},onOk:async()=>{
   if(!alive.current)return;setPending('clear');setError('');
   try{await api('/api/account/ai/clear',{expectedRevision:initial.personal.revision});if(!alive.current)return;dirty.current=false;setEdited(false);form.setFieldValue('apiKey','');message.success('个人模型凭据已移除');onSaved();}
   catch(err){if(alive.current)setError(err.message);}
   finally{confirmation.current=null;busy.current=false;if(alive.current)setPending(null);}
  }});
 }
 const platform=initial.platform;
 return <Card className="account-card personal-ai-card" title={<Space><RobotOutlined/>我的 AI 服务</Space>} extra={<Tag color={initial.canGenerate?'success':'default'}>{initial.source==='personal'?'使用个人 DeepSeek':initial.canGenerate?'使用平台额度':'待开通或配置'}</Tag>}>
 <Alert showIcon type={initial.canGenerate?'info':'warning'} title={initial.message}/>
 <div className="personal-ai-allowance"><div><span>平台本月额度</span><strong>{platform.remaining}<small> / {platform.limit} 次</small></strong></div><div><span>计数月份 · 上海时间</span><strong>{platform.period}</strong></div><Tag>{platform.enabled?'已开通':'未开通'}</Tag></div>
 <p className="ai-service-note">平台额度由管理员手动开通，目前不提供在线购买。次数按发起生成或连接测试计入，失败请求也可能产生模型费用。个人 Key 调用由你自己的 DeepSeek 账户计费。</p>
 <Form layout="vertical" form={form} preserve={false} initialValues={{enabled:initial.personal.enabled,model:initial.personal.model,apiKey:''}} onValuesChange={changed} onFinish={save} disabled={Boolean(pending)} autoComplete="off"><Form.Item name="enabled" label="使用我自己的 DeepSeek" valuePropName="checked"><Switch/></Form.Item><Form.Item name="model" label="模型" rules={[{required:true}]}><Select options={[{value:'deepseek-flash',label:'DeepSeek Flash'},{value:'deepseek-v4-pro',label:'DeepSeek V4 Pro'}]}/></Form.Item><Form.Item name="apiKey" label="自己的 API Key" extra={initial.personal.hasKey?'已保存 Key 不会返回页面。留空保留，填写则替换。':'Key 加密保存在当前工作区服务器，页面不会再次显示。'}><Input.Password autoComplete="new-password" maxLength={8192} placeholder={initial.personal.hasKey?'已保存 · 留空保留':'输入自己的 DeepSeek Key'} /></Form.Item><Space wrap><Button type="primary" htmlType="submit" icon={<SaveOutlined/>} loading={pending==='save'}>保存模型配置</Button><Button icon={<ExperimentOutlined/>} loading={pending==='test'} disabled={!initial.canGenerate||Boolean(pending)||edited} onClick={probe}>测试已保存的连接</Button>{initial.personal.hasKey&&<Button disabled={Boolean(pending)} loading={pending==='clear'} onClick={clear}>移除个人凭据</Button>}</Space></Form>
 {error&&<Alert style={{marginTop:16}} type="error" showIcon title={error}/>} {testResult&&<Alert style={{marginTop:16}} type="success" showIcon title={testResult.message}/>}
 <p className="ai-service-note">点击项目内 AI 生成时，才会发送该工具说明的当前项目资料。<a href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noreferrer">查看模型与计费说明</a></p>
 </Card>;
}
export function PlatformAIAdministration(){
 const resource=useResource('/api/admin/ai/access'),[editing,setEditing]=useState(null),[pending,setPending]=useState(false),[error,setError]=useState('');const [form]=Form.useForm();const {message}=AntApp.useApp();
 async function save(values){if(pending)return;setPending(true);setError('');try{await api('/api/admin/ai/access',{accountId:editing.id,expectedRevision:editing.platform.revision,...values});setEditing(null);resource.refresh();message.success('平台调用额度已更新');}catch(err){setError(err.message);}finally{setPending(false);}}
 return <Card className="settings-card" title="平台 AI 使用权限" extra={<Button icon={<ReloadOutlined/>} onClick={resource.refresh}>刷新</Button>}><p className="ai-service-note">按账号手动开通每月调用次数，额度跨项目共享。新注册账号默认未开通，可自行配置个人 DeepSeek。此处不处理收费、订单或在线支付。</p>{resource.error&&<Alert type="warning" showIcon title={resource.error.message}/>}<Table size="small" loading={resource.loading} rowKey="id" dataSource={resource.value?.users||[]} pagination={{pageSize:8,hideOnSinglePage:true}} scroll={{x:580}} columns={[{title:'使用者',dataIndex:'name'},{title:'平台权限',render:(_,user)=><Tag color={user.platform.enabled?'success':'default'}>{user.platform.enabled?'已开通':'未开通'}</Tag>},{title:'本月已用 / 上限',render:(_,user)=>`${user.platform.used} / ${user.platform.limit}`},{title:'操作',render:(_,user)=><Button size="small" onClick={()=>{setError('');setEditing(user);form.setFieldsValue({enabled:user.platform.enabled,limit:user.platform.limit});}}>调整额度</Button>}]}/><Modal open={Boolean(editing)} title={`平台额度 · ${editing?.name||''}`} centered onCancel={()=>!pending&&setEditing(null)} onOk={()=>form.submit()} confirmLoading={pending} okText="保存开通规则" cancelButtonProps={{disabled:pending}} closable={!pending} mask={{closable:!pending}}><p>按自然月（上海时间）计算；修改上限不会清除已用次数。</p>{error&&<Alert style={{marginBottom:16}} type="error" showIcon title={error}/>}<Form form={form} layout="vertical" onFinish={save} disabled={pending}><Form.Item name="enabled" label="允许使用平台模型" valuePropName="checked"><Switch/></Form.Item><Form.Item name="limit" label="每月调用上限" rules={[{required:true}]}><InputNumber min={0} max={10000} precision={0} style={{width:'100%'}}/></Form.Item></Form></Modal></Card>;
}
