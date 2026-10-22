import React from 'react';
import {Button,Collapse,Tag} from 'antd';
import {DeleteOutlined,ExperimentOutlined,HistoryOutlined} from '@ant-design/icons';
import {safeColor,timeLabel} from './lib.js';
import './sample-project.css';

export function SampleBadge({sample}){return sample?.version===1?<Tag className="sample-project-tag">示例</Tag>:null;}

export function sampleEntryLabel(workspace){
 if(workspace.projects?.some(project=>project.sample?.canArchive===true))return '打开我的示例';
 if(workspace.archivedSamples?.length)return '恢复示例项目';
 return '创建示例项目';
}

export function SampleCreateButton({workspace,onClick,loading=false,disabled=false,size}){
 return <Button icon={<ExperimentOutlined/>} onClick={onClick} loading={loading} disabled={disabled} size={size}>{sampleEntryLabel(workspace)}</Button>;
}

export function ArchivedSamples({samples=[],onRestore,pendingId,disabled=false}){
 if(!samples.length)return null;
 return <Collapse className="archived-samples" ghost items={[{key:'samples',label:<span><HistoryOutlined/> 已删除的示例 <span className="sample-archive-count">{samples.length}</span></span>,children:<><p className="sample-archive-note">恢复会保留你对示例的修改，不会建立新副本。</p>{samples.map(sample=><div className="archived-sample-row" key={sample.id}><i style={{background:safeColor(sample.color)}}/><div><strong>{sample.name}</strong><small>{timeLabel(sample.archivedAt)} 删除 · 可恢复</small></div><Button size="small" loading={pendingId===sample.id} disabled={disabled||!sample.sample?.canRestore} onClick={()=>onRestore(sample.id)}>恢复并打开</Button></div>)}</>}]} />;
}

export function SampleProjectNotice({sample,onArchive,disabled=false}){
 if(sample?.version!==1)return null;
 return <section className="sample-project-notice"><ExperimentOutlined/><div><strong>这是可删除、可恢复的示例项目</strong><p>虚拟伙伴不是真实账号，不会自行回复；管理员可代更新或提交，验收仍由指定接收人处理。此项目不邀请真实伙伴，真实协作请新建空白项目。删除可恢复，保留任务、成果和你的修改。</p>{!sample.canArchive&&<small>此示例由其创建者管理删除与恢复。</small>}</div>{sample.canArchive&&<Button danger disabled={disabled} icon={<DeleteOutlined/>} onClick={onArchive}>删除示例</Button>}</section>;
}
