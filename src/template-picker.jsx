import React,{useMemo,useState} from 'react';
import {Alert,Button,Empty,Modal,Space,Tag} from 'antd';
import {useResource} from './lib.js';
import {TemplateCreateModal} from './productivity.jsx';
export default function TemplatePicker({user,onSaved,onClose,onDirty}){
 const resource=useResource('/api/templates'),[chosen,setChosen]=useState(null);
 const context=useMemo(()=>({schemaVersion:1,revision:1,project:{id:'new-template-context',name:'新项目',description:'',goal:'',color:'#427b68',deadline:''},members:[{id:'m0',name:user.name,role:'项目发起人',accessRole:'admin'}],currentMemberId:'m0',permissions:{manageProject:true,createTask:true,readOnly:false},tasks:[],milestones:[],discussions:[],activities:[],decisions:[]}),[user.id,user.name]);
 if(chosen)return <TemplateCreateModal state={context} template={chosen} mode="create" onSaved={onSaved} onClose={onClose} onDirty={onDirty}/>;
 return <Modal open centered width={740} title="从我的模板创建项目" footer={<Button onClick={onClose}>返回</Button>} onCancel={onClose} styles={{body:{maxHeight:'68vh',overflowY:'auto'}}}><p className="productivity-muted">选择已保存的角色化模板，再核对新项目名称、日程与本人承担的角色。伙伴在创建后通过邀请加入。</p>{resource.error&&<Alert type="warning" showIcon title={resource.error.message} action={<Button onClick={resource.refresh}>重试</Button>}/>}<div className="productivity-template-list">{resource.value?.templates?.map(record=><article key={record.id}><div><strong>{record.name}</strong><p>{record.description||'复用阶段、任务与验收约定'}</p><Space size={4}><Tag>{record.template.roles.length} 个角色</Tag><Tag>{record.template.tasks.length} 项任务</Tag></Space></div><Button type="primary" onClick={()=>setChosen(record)}>选择并核对</Button></article>)}</div>{!resource.loading&&!resource.value?.templates?.length&&<Empty description="还没有私有模板"><p>先在已有项目的设置页提取模板；也可以返回并创建空白项目。</p></Empty>}{resource.loading&&<p>正在读取你的模板…</p>}</Modal>;
}
