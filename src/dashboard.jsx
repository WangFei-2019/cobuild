import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Empty,Input,Pagination,Select,Segmented,Spin,Table,Tag} from 'antd';
import {ArrowRightOutlined,CheckCircleOutlined,ClockCircleOutlined,InboxOutlined,ProjectOutlined,ReloadOutlined,SearchOutlined,TableOutlined,UnorderedListOutlined,WarningOutlined} from '@ant-design/icons';
import {isDemo,dateLabel,safeColor,timeLabel,useResource} from './lib.js';
import {navigate,routeHref,routeSearch} from './router.js';
import {StatusTag} from './shared.jsx';
import {ResourceNotice,ResourceState} from './pages.jsx';
import './dashboard.css';
import {PersonalViewControls,usePersonalView,ViewSortSelect} from './view-preferences.jsx';
import {sortViewTasks} from './view-preferences.js';

const MODES=[
 {key:'owned',title:'我推进',description:'我负责的未完成任务',icon:<InboxOutlined/>},
 {key:'review',title:'待我验收',description:'成果已提交，指定我接收',icon:<CheckCircleOutlined/>},
 {key:'blocked',title:'需协助',description:'我负责且当前受阻',icon:<WarningOutlined/>},
 {key:'related',title:'全部相关',description:'推进与验收事项，合并去重',icon:<UnorderedListOutlined/>}
];
const RELATIONS={owner:'我负责推进',reviewer:'我是接收人','owner-reviewer':'我负责，也由我验收'};
function taskKey(task){return JSON.stringify([task.project.id,task.id]);}
function compareTasks(a,b){return String(a.due||'9999-99-99').localeCompare(String(b.due||'9999-99-99'))||String(a.code||'').localeCompare(String(b.code||''))||String(a.id).localeCompare(String(b.id));}
function personalMode(task,mode){
 const owner=['owner','owner-reviewer'].includes(task.relation),reviewer=['reviewer','owner-reviewer'].includes(task.relation);
 if(task.status==='canceled')return false;
 if(mode==='owned')return owner&&task.status!=='done';
 if(mode==='review')return reviewer&&task.status==='review';
 if(mode==='blocked')return owner&&task.status==='blocked';
 return owner&&task.status!=='done'||reviewer&&task.status==='review';
}
function filterItems(tasks,{projectId,timeFilter,sort}){
 return sortViewTasks(tasks.filter(task=>(!projectId||task.project.id===projectId)&&(timeFilter==='any'||timeFilter==='overdue'&&task.isOverdue||timeFilter==='week'&&task.isDueSoon||timeFilter==='undated'&&!task.due)),sort);
}
export function deriveWorkModel(value,{projectId,timeFilter='any',mode='owned',query='',sort='due'}={}){
 const rows=[...new Map(Object.values(value.sections||{}).flat().filter(Boolean).map(task=>[taskKey(task),task])).values()];
 const personal=filterItems(rows,{projectId,timeFilter,sort}),counts=Object.fromEntries(['owned','review','blocked','related'].map(key=>[key,personal.filter(task=>personalMode(task,key)).length]));
 const searchActive=Boolean(query.trim()),searchReady=!searchActive||value.search?.query===query.trim();
 const selected=searchActive?(searchReady?filterItems(value.search?.tasks||[],{projectId,timeFilter,sort}):[]):personal.filter(task=>personalMode(task,mode));
 const groupMap=new Map();
 for(const task of selected){if(!groupMap.has(task.project.id))groupMap.set(task.project.id,{project:task.project,tasks:[]});groupMap.get(task.project.id).tasks.push(task);}
 const groups=[...groupMap.values()].sort((a,b)=>compareTasks(a.tasks[0],b.tasks[0])||a.project.name.localeCompare(b.project.name,'zh-CN'));
 return {counts,selected,groups,searchReady,personalLimited:Object.values(value.sectionMeta||{}).some(section=>section?.hasMore),searchLimited:Boolean(value.search?.hasMore)};
}
export function taskNextAction(task){
 const owner=['owner','owner-reviewer'].includes(task.relation),reviewer=['reviewer','owner-reviewer'].includes(task.relation);
 if(task.status==='canceled')return {label:'查看取消记录',description:'已取消，不计入待办或完成进度；可查看原因与历史。',kind:'history'};
 if(task.status==='done')return {label:'查看交接记录',description:'已标记完成，核对成果与交接记录。',kind:'history'};
 if(reviewer&&task.status==='review')return {label:'查看待验收成果',description:'对照约定检查成果，再确认接收或退回。',kind:'review'};
 if(owner&&task.status==='blocked')return {label:'处理受阻',description:'核对阻塞原因，说明需要谁提供什么协助。',kind:'blocked'};
 if(owner&&task.status==='review')return {label:'查看交接',description:`等待 ${task.reviewer?.name||'接收人'} 检查；有反馈时补充成果。`,kind:'waiting'};
 if(owner)return {label:task.status==='todo'?'开始推进':'更新任务',description:'记录实际进展，准备并提交约定成果。',kind:'owned'};
 if(reviewer)return {label:'查看约定',description:`等待 ${task.owner?.name||'负责人'} 提交成果后再验收。`,kind:'waiting'};
 return {label:'查看任务',description:'这是可访问的项目任务，未直接分配给我。',kind:'other'};
}
function TaskItem({task}){
 const action=taskNextAction(task);
 return <article className={`my-work-task ${action.kind}`} style={{'--work-project-color':safeColor(task.project.color)}}>
  <div className="my-work-task-main"><div className="my-work-task-code"><button className="my-work-task-project" title={`${task.project.name} · 进入项目`} onClick={()=>navigate(routeHref(task.project.id))}><i aria-hidden="true"/>{task.project.name}</button><span>{task.code||'任务'}</span>{task.priority==='high'&&<Tag color="orange">高优先级</Tag>}</div><button className="my-work-task-title" onClick={()=>navigate(routeHref(task.project.id,'tasks',task.id))}>{task.title}</button><div className={`my-work-due${task.isOverdue?' overdue':''}`}><ClockCircleOutlined/><span>{task.due?`${dateLabel(task.due)} 截止`:'未设置截止日期'}</span>{task.isOverdue&&<strong>已逾期</strong>}{!task.isOverdue&&task.isDueSoon&&<span>7 天内</span>}</div>{task.blocker&&<p className="my-work-blocker"><WarningOutlined/>{task.blocker}</p>}</div>
  <div className="my-work-task-responsibility"><span>{RELATIONS[task.relation]||'未直接分配给我'}</span><StatusTag value={task.status}/></div>
  <div className="my-work-task-next"><p>{action.description}</p><Button type={action.kind==='review'?'primary':'default'} size="small" onClick={()=>navigate(routeHref(task.project.id,'tasks',task.id))}>{action.label}<ArrowRightOutlined/></Button></div>
 </article>;
}
function ProjectGroup({group}){
 const [page,setPage]=useState(1),pageSize=8,current=Math.min(page,Math.max(1,Math.ceil(group.tasks.length/pageSize)));
 return <section className="my-work-project" style={{'--work-project-color':safeColor(group.project.color)}} aria-label={`${group.project.name}的当前事项`}><header><span className="my-work-project-icon"><ProjectOutlined/><i/></span><div><h3><button onClick={()=>navigate(routeHref(group.project.id))}>{group.project.name}</button></h3><span>{group.tasks.length} 项符合当前筛选</span></div><Button type="text" size="small" onClick={()=>navigate(routeHref(group.project.id))}>进入项目<ArrowRightOutlined/></Button></header><div className="my-work-column-labels" aria-hidden="true"><span>任务</span><span>我的关系与状态</span><span>下一步</span></div>{group.tasks.slice((current-1)*pageSize,current*pageSize).map(task=><TaskItem key={taskKey(task)} task={task}/>)}{group.tasks.length>pageSize&&<Pagination className="my-work-group-pagination" current={current} pageSize={pageSize} total={group.tasks.length} size="small" showSizeChanger={false} onChange={setPage}/>}</section>;
}
export default function Dashboard({workspace,user}){
 const [query,setQuery]=useState(()=>(new URLSearchParams(routeSearch()).get('q')||'').slice(0,120)),[debounced,setDebounced]=useState(''),searchInput=useRef(null);
 const preference=usePersonalView({kind:'dashboard',projectIds:workspace.projects.map(project=>project.id)}),{mode,projectId,timeFilter,view,sort}=preference.values;
 const setMode=value=>preference.setField('mode',value),setProjectId=value=>preference.setField('projectId',value),setTimeFilter=value=>preference.setField('timeFilter',value),setView=value=>preference.setField('view',value);
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(query.trim()),350);return()=>clearTimeout(timer);},[query]);
 const resource=useResource(`/api/dashboard${debounced?`?q=${encodeURIComponent(debounced)}`:''}`,{interval:10000,keepPrevious:true});
 useEffect(()=>{if(new URLSearchParams(routeSearch()).get('search')==='1')searchInput.current?.focus();},[routeSearch(),Boolean(resource.value)]);
 if(!resource.value||[401,403,404].includes(resource.error?.status))return <ResourceState loading={resource.loading} error={resource.error} onRetry={resource.refresh}/>;
 const value=resource.value,searchActive=Boolean(query.trim()),model=deriveWorkModel(value,{projectId,timeFilter,mode,query,sort}),searchReady=model.searchReady&&query.trim()===debounced;
 const selected=searchActive&&!searchReady?[]:model.selected,groups=searchActive&&!searchReady?[]:model.groups,currentMode=MODES.find(item=>item.key===mode);
 function chooseMode(key){setMode(key);setQuery('');setDebounced('');}
 function clearFilters(){setQuery('');setDebounced('');setProjectId(undefined);setTimeFilter('any');}
 const filtered=Boolean(projectId||timeFilter!=='any'),limited=searchActive?searchReady&&model.searchLimited:model.personalLimited;
 const columns=[
  {title:'项目与任务',key:'title',width:340,render:(_,task)=><div className="my-work-table-task" style={{'--work-project-color':safeColor(task.project.color)}}><button className="my-work-table-project my-work-task-project" title={`${task.project.name} · 进入项目`} onClick={()=>navigate(routeHref(task.project.id))}><i/>{task.project.name}</button><button className="my-work-task-title" onClick={()=>navigate(routeHref(task.project.id,'tasks',task.id))}>{task.code} · {task.title}</button></div>},
  {title:'我的关系',dataIndex:'relation',width:150,render:relation=>RELATIONS[relation]||'未直接分配给我'},
  {title:'状态',dataIndex:'status',width:110,render:status=><StatusTag value={status}/>},
  {title:'截止日期',dataIndex:'due',width:125,render:(date,task)=><span className={task.isOverdue?'my-work-overdue-text':''}>{dateLabel(date)}{task.isOverdue?' · 逾期':''}</span>},
  {title:'下一动作',key:'action',width:180,render:(_,task)=><Button size="small" type={taskNextAction(task).kind==='review'?'primary':'default'} onClick={()=>navigate(routeHref(task.project.id,'tasks',task.id))}>{taskNextAction(task).label}<ArrowRightOutlined/></Button>}
 ];
 const emptyMessage=searchActive?'没有符合当前筛选的可访问任务':!workspace.projects.length?'还没有可见项目':mode==='review'?'当前没有等待你验收的成果':mode==='blocked'?'你负责的任务当前没有受阻事项':mode==='related'?'当前没有需要你推进或验收的事项':'当前没有由你负责的未完成任务';
 return <div className="my-work-page"><ResourceNotice resource={resource}/><header className="my-work-heading"><div><div className="my-work-title-line"><h1>我的待办</h1><span>{dateLabel(value.today,true)} · {user.name}</span></div><p>按项目查看我负责推进、等待我验收，以及需要协助的事项。</p></div><div><PersonalViewControls preference={preference}/><Button icon={<ReloadOutlined/>} loading={resource.refreshing} onClick={resource.refresh}>刷新</Button></div></header>

  <div className="my-work-modes" role="group" aria-label="选择个人待办模式">{MODES.map(item=><button id={`my-work-tab-${item.key}`} key={item.key} title={`${item.description}${searchActive?'；点击返回个人待办':''}`} aria-label={`${item.title} ${model.counts[item.key]}项，${item.description}`} aria-pressed={!searchActive&&mode===item.key} aria-controls="my-work-results" className={`my-work-mode ${item.key}${!searchActive&&mode===item.key?' active':''}`} onClick={()=>chooseMode(item.key)}><span className="my-work-mode-icon">{item.icon}</span><span className="my-work-mode-text"><strong>{item.title}</strong></span><b>{model.counts[item.key]}</b></button>)}</div>
  <section className="my-work-browser" id="my-work-results" aria-label={searchActive?'可访问任务搜索结果':currentMode.title}>
   <div className="my-work-filters"><Input ref={searchInput} allowClear prefix={<SearchOutlined/>} placeholder="跨项目搜索任务、编号或交付物" value={query} maxLength={120} aria-label="搜索所有可访问的任务" onChange={event=>setQuery(event.target.value)}/><Select allowClear value={projectId||undefined} onChange={setProjectId} placeholder="所有项目" aria-label="按项目筛选待办" options={workspace.projects.map(project=>({value:project.id,label:project.name}))}/><Select value={timeFilter} onChange={setTimeFilter} aria-label="按期限筛选待办" options={[{value:'any',label:'所有期限'},{value:'overdue',label:'已逾期'},{value:'week',label:'7 天内截止'},{value:'undated',label:'未设截止'}]}/><ViewSortSelect value={sort} onChange={value=>preference.setField('sort',value)}/><Segmented value={view} onChange={setView} aria-label="工作列表展示方式" options={[{value:'grouped',label:<span><UnorderedListOutlined/><span className="my-work-view-label">按项目</span></span>},{value:'table',label:<span><TableOutlined/><span className="my-work-view-label">表格</span></span>}]}/></div>
   <div className="my-work-scope-line"><p>{searchActive?'搜索可访问的任务，包含未分配给我的工作。':mode==='owned'?'我负责的未完成任务，包含受阻和待交接。':mode==='review'?'成果已提交、等待我接收的任务。':mode==='blocked'?'由我负责且当前受阻，需要进一步明确协助。':'推进与验收合并去重，不含已完成历史。'}</p><span>{searchActive&&!searchReady?'正在搜索…':`${limited?'已加载 ':''}${selected.length} 项 · ${groups.length} 个项目`}</span>{searchActive&&<Button type="link" size="small" onClick={()=>chooseMode(mode)}>返回个人待办</Button>}{filtered?<Button type="link" size="small" onClick={clearFilters}>清除筛选</Button>:null}</div>
   {searchActive&&!searchReady?<div className="my-work-search-loading"><Spin/><span>正在读取搜索结果…</span></div>:!selected.length?<div className="my-work-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyMessage}>{filtered||searchActive?<Button onClick={clearFilters}>清除筛选</Button>:<Button onClick={()=>navigate('/projects')}>查看项目与分工</Button>}</Empty></div>:view==='grouped'?<div className="my-work-projects">{groups.map(group=><ProjectGroup key={`${group.project.id}:${mode}:${debounced}:${timeFilter}`} group={group}/>)}</div>:<Table className="my-work-table" rowKey={taskKey} columns={columns} dataSource={selected} size="middle" scroll={{x:920}} pagination={selected.length>12?{pageSize:12,showSizeChanger:false,showTotal:total=>`当前筛选 ${total} 项`}:false}/>}
   {limited&&<Alert className="my-work-limit" type="info" showIcon title={searchActive?`搜索共 ${value.search?.total||0} 项，接口当前仅返回前 ${value.search?.tasks?.length||0} 项。`:'个人分区每次最多返回 200 项；当前数量与列表均按已加载事项计算。'} description="项目或期限筛选只作用于已返回的条目。请缩小搜索，或进入具体项目查看完整任务。"/>}
  </section><footer className="my-work-footer"><span>{isDemo?'本地体验角色的分工':'当前账号实际绑定的分工'} · 未绑定的历史成员任务不会自动算到个人待办</span><span>更新于 {timeLabel(value.generatedAt)}</span></footer>
 </div>;
}
