import {useEffect,useRef,useState} from 'react';
export const STATUS={todo:'待开始',doing:'进行中',blocked:'受阻',review:'待交接',done:'已完成'};
export const STATUS_COLOR={todo:'default',doing:'processing',blocked:'warning',review:'purple',done:'success'};
export const PRIORITY={high:'高',medium:'普通',low:'低'};
export const PRIORITY_ORDER={high:0,medium:1,low:2};
export const isDemo=typeof __COBUILD_DEMO__!=='undefined'&&__COBUILD_DEMO__;
export const safeColor=value=>/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value||'')?value:'#28577b';
export const canManage=state=>state?.permissions?.manageProject===true;
export const canCreate=state=>canManage(state)||state?.permissions?.createTask===true;
export function dateLabel(value,year=false){if(!value)return '未设置';const date=new Date(String(value).length===10?`${value}T12:00:00`:value);return Number.isNaN(date.getTime())?value:date.toLocaleDateString('zh-CN',{year:year?'numeric':undefined,month:'2-digit',day:'2-digit'});}
export function timeLabel(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
export function safeURL(value){if(!value)return '';if(/^\/api\/files\/[a-z0-9-]+$/i.test(value)||/^\/samples\/[\w.-]+$/.test(value))return value;try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export async function api(url,payload,{signal}={}){if(typeof __COBUILD_DEMO__!=='undefined'&&__COBUILD_DEMO__){const {demoRequest}=await import('./demo-api.js');return demoRequest(url,payload,{signal});}let response;try{response=await fetch(url,payload===undefined?{cache:'no-store',credentials:'same-origin',signal}:{method:'POST',credentials:'same-origin',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch(error){if(error.name==='AbortError')throw error;throw new Error('无法连接协作服务，请检查网络后重试。');}const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||`操作失败（${response.status}）`);error.status=response.status;error.code=data.code;throw error;}return data;}
export function download(url){if(typeof __COBUILD_DEMO__!=='undefined'&&__COBUILD_DEMO__)return import('./demo-api.js').then(module=>module.demoDownload(url));const anchor=document.createElement('a');anchor.href=url;anchor.download='';document.body.append(anchor);anchor.click();anchor.remove();}
export function useResource(url,{interval=0,keepPrevious=false}={}){
 const [entry,setEntry]=useState({url:null,value:null}),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(null),[revision,setRevision]=useState(0),currentURL=useRef(null);
 useEffect(()=>{let active=true,inFlight=false,controller=null;const changed=currentURL.current!==url;currentURL.current=url;if(changed)setEntry(current=>({url,value:keepPrevious?current.value:null}));if(changed||entry.value===null)setLoading(true);setError(null);
 const load=async()=>{if(inFlight)return;inFlight=true;controller=new AbortController();setRefreshing(true);try{const result=await api(url,undefined,{signal:controller.signal});if(active){setEntry({url,value:result});setError(null);}}catch(err){if(active&&err.name!=='AbortError')setError(err);}finally{inFlight=false;if(active){setLoading(false);setRefreshing(false);}}};load();const timer=interval?setInterval(load,interval):null;return()=>{active=false;controller?.abort();if(timer)clearInterval(timer);};},[url,interval,revision,keepPrevious]);
 return {value:entry.url===url||keepPrevious?entry.value:null,loading:entry.url!==url||loading,refreshing,error,refresh:()=>setRevision(value=>value+1)};
}
