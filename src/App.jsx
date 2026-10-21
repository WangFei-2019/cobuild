import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Button,Dropdown,Result,Spin,Tag} from 'antd';
import {AppstoreOutlined,DashboardOutlined,SearchOutlined,EllipsisOutlined,LogoutOutlined,PlusOutlined,ProjectOutlined,SettingOutlined,TeamOutlined,UserOutlined} from '@ant-design/icons';
import {api,isDemo} from './lib.js';
import Dashboard from './dashboard.jsx';
import {migrateLegacyURL,navigate,routeHref,routeURL,setNavigationGuard,useRoute} from './router.js';
import {ProjectCenter,ReferencesModal} from './shared.jsx';
import {NewProjectModal} from './project-components.jsx';
import ProjectPage from './project-page.jsx';
import {AuthPage,InvitePage,PeoplePage,PersonPage,ResourceState,SettingsPage} from './pages.jsx';
migrateLegacyURL();
export default function Application(){
 const {message,modal}=AntApp.useApp(),route=useRoute();
 const [session,setSession]=useState(null),[sessionError,setSessionError]=useState(null),[demoEpoch,setDemoEpoch]=useState(0);
 useEffect(()=>{if(route.kind!=='project')document.title=`${({dashboard:'我的工作台',projects:'项目中心',people:'成员目录',person:'成员主页',settings:'工作区设置',login:'登录',setup:'首次设置',invite:'项目邀请','404':'页面不存在'})[route.kind]||'共建'} · 共建`;},[route.kind]);
 async function loadSession(){try{setSession(await api('/api/auth/session'));setSessionError(null);}catch(error){setSessionError(error);}}
 useEffect(()=>{loadSession();},[]);
 useEffect(()=>{if(!session||isDemo)return;if(session.setupRequired&&route.kind!=='setup')navigate('/setup',{replace:true});else if(!session.setupRequired&&!session.user&&!['login','invite'].includes(route.kind)){const url=routeURL();navigate(`/login?next=${encodeURIComponent(url.pathname+url.search)}`,{replace:true});}else if(session.user&&['login','setup'].includes(route.kind))navigate(route.next?.startsWith('/')&&!route.next.startsWith('//')?route.next:'/dashboard',{replace:true});},[session,route.kind]);
 async function logout(){try{await api('/api/auth/logout',{});setNavigationGuard(null);setSession({setupRequired:false,user:null});navigate('/login',{replace:true});}catch(error){message.error(error.message);}}
 if(sessionError&&isDemo)return <Result status="warning" title="暂时无法读取本地演示" subTitle={sessionError.message} extra={<><Button onClick={loadSession}>重新读取</Button><Button danger onClick={()=>modal.confirm({title:'重置本地演示数据？',content:'此操作会清除当前浏览器中本演示的所有修改，并恢复初始示例。',okText:'确认重置',okButtonProps:{danger:true},onOk:async()=>{try{const result=await api('/api/demo/reset',{});setSession(result);setSessionError(null);navigate('/dashboard',{replace:true});setDemoEpoch(value=>value+1);}catch(err){message.error(err.message);throw err;}}})}>重置演示</Button></>}/>;
 if(sessionError)return <ResourceState error={sessionError} onRetry={loadSession}/>;
 if(!session)return <div className="initial-loading"><Spin/><span>{isDemo?'正在载入本地演示…':'正在验证账号…'}</span></div>;
 if(isDemo&&['setup','login','invite'].includes(route.kind))return <Result status="info" title="这是 GitHub Pages 本地演示" subTitle="演示不提供真实账号、邀请或异地同步。返回工作台即可体验项目、任务、里程碑与成果交接，修改保存在当前浏览器。" extra={<Button type="primary" onClick={()=>navigate('/dashboard',{replace:true})}>进入演示工作台</Button>}/>;
 if(route.kind==='setup')return <AuthPage mode="setup" session={session} onAuth={setSession}/>;
 if(route.kind==='login')return <AuthPage mode="login" session={session} next={route.next} onAuth={setSession}/>;
 if(route.kind==='invite')return <InvitePage token={route.token} session={session} onAuth={setSession} onLogout={logout}/>;
 if(!session.user)return <div className="initial-loading"><Spin/></div>;
 return <Workspace key={demoEpoch} session={session} route={route} onLogout={logout} onSessionExpired={loadSession} onDemoReset={()=>setDemoEpoch(value=>value+1)}/>;
}
function Workspace({session,route,onLogout,onSessionExpired,onDemoReset}){
 const {message,modal}=AntApp.useApp(),[workspace,setWorkspace]=useState(null),[error,setError]=useState(null),[createOpen,setCreateOpen]=useState(false),[referencesOpen,setReferencesOpen]=useState(false);
 const createDirty=useRef(false),alive=useRef(true);
 async function refresh(){try{const result=await api('/api/workspace');if(!alive.current)return;setWorkspace(result);setError(null);}catch(err){if(!alive.current)return;setError(err);if(err.status===401)onSessionExpired();}}
 useEffect(()=>{alive.current=true;refresh();const timer=setInterval(refresh,5000);return()=>{alive.current=false;clearInterval(timer);};},[]);
 useEffect(()=>{const cleanup=setNavigationGuard(()=>{if(!createDirty.current)return true;if(!window.confirm('新项目表单尚未保存，确定放弃并离开？'))return false;createDirty.current=false;setCreateOpen(false);return true;});const beforeUnload=event=>{if(createDirty.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);return()=>{cleanup();window.removeEventListener('beforeunload',beforeUnload);};},[]);
 async function create(values){try{const result=await api('/api/projects',{...values,ownerName:session.user.name,ownerPersonId:session.user.personId});setWorkspace(result.workspace);createDirty.current=false;navigate(routeHref(result.state.project.id));message.success('项目已创建');return true;}catch(err){message.error(err.message);return false;}}
 function resetDemo(){modal.confirm({title:'重置当前浏览器的演示数据？',content:'你在此演示中创建的项目、成员、任务、文件和未保存草稿将清除，恢复初始示例。此操作无法撤销。',okText:'重置演示',okButtonProps:{danger:true},cancelText:'保留数据',onOk:async()=>{try{await api('/api/demo/reset',{});createDirty.current=false;setNavigationGuard(null);navigate('/dashboard',{replace:true});onDemoReset();message.success('已恢复演示示例');}catch(err){message.error(err.message);throw err;}}});}
 if(!workspace||[401,403].includes(error?.status))return <ResourceState loading={!error} error={error} onRetry={refresh}/>;
 const project=workspace.projects.find(item=>item.id===route.projectId);
 let content;
 if(route.kind==='dashboard')content=<main className="workspace-main standalone-page"><Dashboard workspace={workspace} user={session.user}/></main>;
 else if(route.kind==='projects')content=<main className="workspace-main project-center-main"><ProjectCenter workspace={workspace} onSelect={id=>navigate(routeHref(id))} onCreate={()=>setCreateOpen(true)}/></main>;
 else if(route.kind==='project')content=<ProjectPage key={route.projectId} route={route} metadata={project} onWorkspaceRefresh={refresh} onSessionExpired={onSessionExpired}/>;
 else if(route.kind==='people')content=<main className="workspace-main standalone-page"><PeoplePage/></main>;
 else if(route.kind==='person')content=<main className="workspace-main standalone-page"><PersonPage key={route.personId} personId={route.personId}/></main>;
 else if(route.kind==='settings')content=<main className="workspace-main standalone-page"><SettingsPage session={session}/></main>;
 else content=<Result status="404" title="页面不存在" extra={<Button onClick={()=>navigate('/dashboard')}>返回工作台</Button>}/>;
 const menuItems=[{key:'references',label:'参考产品与界面组件'},{key:'settings',label:isDemo?'演示与存储说明':'模型与工作区设置'},{type:'divider'},isDemo?{key:'reset',label:'重置演示数据',danger:true}:{key:'logout',label:'退出登录',icon:<LogoutOutlined/>}];
 return <div className={`space-layout${isDemo?' is-demo':''}`}>
 {isDemo&&<div className="demo-banner" role="status"><div><Tag color="cyan">GitHub Pages 演示</Tag><strong>数据保存在当前浏览器</strong><span>无异地同步 · 规划为内置示例</span></div><Button size="small" onClick={resetDemo}>重置演示</Button></div>}
 <aside className="project-sidebar"><div className="space-brand"><span><ProjectOutlined/></span><strong>共建</strong></div><Button className="sidebar-create" type="primary" icon={<PlusOutlined/>} block onClick={()=>setCreateOpen(true)}>新建项目</Button><nav className="global-navigation" aria-label="工作区导航">{[{kind:'dashboard',label:'我的工作台',icon:<DashboardOutlined/>},{kind:'projects',label:'项目',icon:<AppstoreOutlined/>},{kind:'people',label:'成员',icon:<TeamOutlined/>},{kind:'settings',label:'设置',icon:<SettingOutlined/>}].map(item=><button key={item.kind} className={`center-nav${route.kind===item.kind||item.kind==='projects'&&route.kind==='project'||item.kind==='people'&&route.kind==='person'?' active':''}`} onClick={()=>navigate(`/${item.kind}`)}>{item.icon}<span>{item.label}</span></button>)}</nav><div className="sidebar-section-label">参与的项目</div><nav className="project-nav" aria-label="项目列表">{workspace.projects.map(item=><button key={item.id} className={`project-nav-item${route.projectId===item.id?' active':''}`} onClick={()=>navigate(routeHref(item.id))}><span className="sidebar-project-icon" style={{color:item.color}}><ProjectOutlined/></span><span><strong>{item.name}</strong><small>{item.memberCount} 位成员 · {item.taskCount} 项任务</small></span></button>)}</nav><div className="sidebar-help"><button onClick={()=>navigate(`/people/${session.user.personId}`)}><UserOutlined/> {session.user.name}</button>{!isDemo&&<button onClick={onLogout}>退出登录</button>}</div></aside>
 <div className="space-content"><div className="space-topbar"><div className="space-breadcrumb"><button onClick={()=>navigate('/projects')}>工作区</button><span>/</span><strong>{project?.name||({dashboard:'我的工作台',projects:'项目中心',people:'成员目录',person:'成员主页',settings:'设置'})[route.kind]||'项目'}</strong></div><div className="space-topbar-actions"><Button className="global-search-button" type="text" icon={<SearchOutlined/>} aria-label="跨项目搜索任务" onClick={()=>navigate('/dashboard?search=1')}>搜索任务</Button><Button className="account-button" type="text" icon={<UserOutlined/>} onClick={()=>navigate(`/people/${session.user.personId}`)}>{session.user.name}</Button><Dropdown menu={{items:menuItems,onClick:({key})=>{if(key==='references')setReferencesOpen(true);if(key==='settings')navigate('/settings');if(key==='logout')onLogout();if(key==='reset')resetDemo();}}}><Button icon={<EllipsisOutlined/>} aria-label="账号与工作区操作"/></Dropdown></div></div>{content}</div>
 {createOpen&&<NewProjectModal ownerName={session.user.name} onCreate={create} onDirty={value=>{createDirty.current=value;}} onClose={()=>{if(!createDirty.current||window.confirm('放弃尚未保存的新项目表单？')){createDirty.current=false;setCreateOpen(false);}}}/>}
 {referencesOpen&&<ReferencesModal onClose={()=>setReferencesOpen(false)}/>}
 </div>;
}
