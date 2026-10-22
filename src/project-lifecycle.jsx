import React from 'react';
import {Button,Collapse,Tooltip} from 'antd';
import {FolderOpenOutlined,InboxOutlined} from '@ant-design/icons';
import {safeColor,timeLabel} from './lib.js';
import './project-lifecycle.css';

export function ProjectArchiveControl({sample,permissions,onArchive}){
 if(sample||!permissions?.canArchive)return null;
 return <section className="project-archive-control"><div><h3><InboxOutlined/> 归档项目</h3><p>暂时移出进行中的工作区，保留成员、任务、成果和历史。项目管理员可在项目中心恢复；归档不会删除项目数据。</p></div><Button onClick={onArchive}>归档项目</Button></section>;
}
export function ArchivedProjects({projects=[],onRestore,pendingId,disabled=false}){
 if(!projects.length)return null;
 return <Collapse ghost className="archived-real-projects" items={[{key:'projects',label:<span><FolderOpenOutlined/> 已归档项目 <b>{projects.length}</b></span>,children:<><p>归档项目暂不进入待办与通知。恢复后保留原有分工和记录；恢复权限由项目角色决定。</p>{projects.map(project=><div className="archived-project-row" key={project.id}><i style={{background:safeColor(project.color)}}/><div><strong>{project.name}</strong><small>{timeLabel(project.archivedAt)} 归档</small></div><Tooltip title={!project.canRestore?'仅项目管理员可恢复':undefined}><Button size="small" disabled={disabled||!project.canRestore} loading={pendingId===project.id} onClick={()=>onRestore(project.id)}>恢复并打开</Button></Tooltip></div>)}</>}]} />;
}
