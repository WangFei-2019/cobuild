import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Alert,Button,Empty,Input,Segmented,Select,Space,Tag} from 'antd';
import {ArrowRightOutlined,BellOutlined,CheckOutlined,ReloadOutlined,SearchOutlined} from '@ant-design/icons';
import {api,isDemo,safeColor,timeLabel} from './lib.js';
import {navigate,parseRoute,safeNextPath} from './router.js';
import {PageHeading,ResourceState} from './pages.jsx';
import './notifications.css';

const TYPES={mention:'有人 @ 我',reply:'讨论有回复',assigned:'待我推进',review:'待我验收',blocked:'受阻事项',due:'期限提醒',handoff_accepted:'交接已接收',changes_requested:'退回修改',invitation_accepted:'伙伴已加入'};
export function notificationTarget(href){const path=safeNextPath(href,'');return path&&parseRoute(new URL(path,location.origin)).kind==='project'?path:'';}

export function useNotifications(onUnauthorized){
 const [value,setValue]=useState(null),[error,setError]=useState(null),[refreshing,setRefreshing]=useState(false),[pending,setPending]=useState(null),[actionError,setActionError]=useState(null);
 const alive=useRef(true),sequence=useRef(0),loading=useRef(false),writing=useRef(false),unauthorized=useRef(onUnauthorized);unauthorized.current=onUnauthorized;
 const {message}=AntApp.useApp();
 function accept(result){if(!Array.isArray(result.items))throw new Error('通知数据不完整，请重试。');setValue(result);}
 async function refresh(){
  if(loading.current||writing.current)return;loading.current=true;const stamp=sequence.current;setRefreshing(true);
  try{const result=await api('/api/notifications');if(alive.current&&stamp===sequence.current){accept(result);setError(null);}}
  catch(err){if(alive.current&&stamp===sequence.current){setError(err);if(err.status===401)unauthorized.current?.();}}
  finally{loading.current=false;if(alive.current)setRefreshing(false);}
 }
 useEffect(()=>{alive.current=true;refresh();const timer=setInterval(refresh,12000);return()=>{alive.current=false;sequence.current+=1;clearInterval(timer);};},[]);
 async function markRead(item){
  if(writing.current)return false;writing.current=true;sequence.current+=1;setPending(item==='all'?'all':item.id);setActionError(null);
  try{const result=await api('/api/notifications/read',item==='all'?{all:true}:{ids:[item.id]});if(!alive.current)return false;accept(result);setError(null);return true;}
  catch(err){if(alive.current){setActionError(err);message.warning('未能保存已读状态，通知仍会保留');if(err.status===401)unauthorized.current?.();}return false;}
  finally{writing.current=false;if(alive.current)setPending(null);}
 }
 return {value,error,refreshing,pending,actionError,refresh,markRead};
}

export default function NotificationsPage({notifications,workspace}){
 const [filter,setFilter]=useState('all'),[type,setType]=useState(undefined),[query,setQuery]=useState('');
 const pageAlive=useRef(true);useEffect(()=>()=>{pageAlive.current=false;},[]);
 const {value,error,refresh,refreshing,pending,markRead}=notifications;
 if(!value||[401,403].includes(error?.status))return <ResourceState loading={!value&&!error} error={error} onRetry={refresh}/>;
 const rows=value.items.filter(item=>(filter!=='unread'||!item.read)&&(!type||item.type===type)&&(!query.trim()||`${item.title} ${item.description} ${item.projectName||''} ${item.taskCode||''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
 async function open(item){const href=notificationTarget(item.href);if(!href)return;if(!item.read)await markRead(item);if(pageAlive.current)navigate(href);}
 return <section className="notifications-page"><div className="page-eyebrow"><BellOutlined/> 协作提醒</div><PageHeading title="通知中心" description="查看分工、交接和期限事项；打开相关项目继续处理。" extra={<Space wrap><Button icon={<ReloadOutlined/>} loading={refreshing} disabled={Boolean(pending)} onClick={refresh}>刷新</Button><Button icon={<CheckOutlined/>} disabled={!value.unreadCount||Boolean(pending)} loading={pending==='all'} onClick={()=>markRead('all')}>全部标为已读</Button></Space>}/>
  {error&&<Alert type="warning" showIcon style={{marginBottom:18}} title="通知暂未刷新，当前显示上次内容" description={error.message}/>}
  {notifications.actionError&&<Alert type="warning" showIcon style={{marginBottom:18}} title="已读状态尚未保存" description="你可以重试标记，或直接打开相关事项；不会把失败操作显示为已读。"/>}
  <div className="notification-filters"><Segmented aria-label="筛选通知已读状态" value={filter} onChange={setFilter} options={[{value:'all',label:'全部'},{value:'unread',label:`未读 ${value.unreadCount}`} ]}/><Select allowClear value={type} onChange={setType} aria-label="筛选通知类型" placeholder="全部类型" options={Object.entries(TYPES).map(([value,label])=>({value,label}))}/><Input allowClear prefix={<SearchOutlined/>} aria-label="搜索通知" placeholder="搜索标题或说明" value={query} onChange={event=>setQuery(event.target.value)}/></div>
  <div className="notification-list">{rows.map(item=>{const project=workspace.projects.find(project=>project.id===item.projectId),target=notificationTarget(item.href);return <article className={`notification-row${item.read?' is-read':''}`} key={item.id}><span className="notification-unread-dot" aria-label={item.read?'已读':'未读'}/><div className="notification-copy"><div className="notification-meta"><Tag>{TYPES[item.type]||'项目提醒'}</Tag>{(project||item.projectName)&&<span className="notification-project">{project&&<i style={{background:safeColor(project.color)}}/>}{project?.name||item.projectName}</span>}<time>{timeLabel(item.createdAt)}</time></div><h2>{item.title}</h2><p>{item.description}</p></div><div className="notification-actions">{target?<Button size="small" disabled={Boolean(pending)} onClick={()=>open(item)}>查看事项<ArrowRightOutlined/></Button>:<span>事项暂不可访问</span>}{item.read?<span>已读</span>:<Button type="text" size="small" loading={pending===item.id} disabled={Boolean(pending)} onClick={()=>markRead(item)}>标为已读</Button>}</div></article>;})}{!rows.length&&<div className="notification-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={value.items.length?'当前筛选下没有通知':'暂无需要处理的协作通知'}>{(filter!=='all'||type||query)&&<Button onClick={()=>{setFilter('all');setType(undefined);setQuery('');}}>查看全部通知</Button>}</Empty></div>}</div>
  <p className="notification-scope">{isDemo?'已读状态仅存当前浏览器。':'已读状态保存在当前账号。'}通知反映当前有权访问的事项，不代替完整项目历史。{value.hasMore&&` 当前仅显示前 ${value.items.length} 条，共 ${value.total} 条；请进入具体项目查看完整动态。`}</p>
 </section>;
}
