import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Alert,Button,ConfigProvider,Input} from 'antd';
import {ArrowRightOutlined,CheckOutlined,GlobalOutlined,LinkOutlined,ProjectOutlined} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import {normalizeServiceOrigin} from './service-origin.js';
import 'antd/dist/reset.css';
import './service-entry.css';

const STORAGE_KEY='cobuild.service-origin.v1',configured=__COBUILD_SERVICE_URL__;
function previousOrigin(){try{const value=localStorage.getItem(STORAGE_KEY);return value?normalizeServiceOrigin(value):configured;}catch{return configured;}}
function ServiceEntry(){
 const [address,setAddress]=useState(previousOrigin),[error,setError]=useState(''),[storageNote,setStorageNote]=useState('');
 let destination='';try{destination=normalizeServiceOrigin(address);}catch{}
 const demoHref='./demo.html'+(location.hash.startsWith('#/')?location.hash:'#/dashboard');
 function connect(event){
  event.preventDefault();setError('');
  try{
   const origin=normalizeServiceOrigin(address);
   if(origin===location.origin&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname))throw new Error('这是静态入口的地址，请填写实际运行共建服务的地址。');
   try{localStorage.setItem(STORAGE_KEY,origin);}catch{setStorageNote('浏览器未允许保存地址，本次仍可进入工作区。');}
   location.assign(origin+'/');
  }catch(err){setError(err.message);}
 }
 return <div className="service-entry">
  <header className="entry-header"><a className="entry-brand" href="./index.html"><span><ProjectOutlined/></span><strong>共建<small>CoBuild</small></strong></a><a className="entry-docs" href="https://github.com/WangFei-2019/cobuild/blob/main/部署与配置.md" target="_blank" rel="noopener noreferrer">部署指南<ArrowRightOutlined/></a></header>
  <main className="entry-main">
   <section className="entry-intro" aria-labelledby="intro-title"><p className="entry-eyebrow"><i/> 项目协作 · 从目标到交付</p><h1 id="intro-title">共同推进，<br/><span>一起交付。</span></h1><p className="entry-description">把项目、伙伴和下一步工作连在一起。<br/>用真实账号加入团队，让分工与成果都有着落。</p><ol className="entry-flow"><li><span className="flow-dot jade"><CheckOutlined/></span><div><strong>确定共同目标</strong><p>建立项目，规划任务与里程碑</p></div></li><li><span className="flow-dot amber"><CheckOutlined/></span><div><strong>邀请伙伴协作</strong><p>按项目分工，查看各自负责的进展</p></div></li><li><span className="flow-dot blue"><CheckOutlined/></span><div><strong>提交并确认成果</strong><p>依据交付约定完成验收，留下记录</p></div></li></ol></section>
   <section className="entry-connect" aria-labelledby="connect-title"><div className="entry-connect-heading"><span className="entry-connect-icon"><GlobalOutlined/></span><span>团队工作区</span></div><h2 id="connect-title">进入共建工作区</h2><p className="entry-connect-copy">填写工作区的服务地址，前往登录或注册账号。</p><form onSubmit={connect} noValidate><label htmlFor="service-address">工作区服务地址</label><Input id="service-address" size="large" prefix={<LinkOutlined/>} placeholder="https://team.example.com:5175" value={address} maxLength={300} autoComplete="url" spellCheck={false} status={error?'error':undefined} aria-describedby="service-help service-error" onChange={event=>{setAddress(event.target.value);setError('');}}/><p id="service-help" className="entry-field-help">支持域名或 IP 地址与端口。请核对这是你信任的团队服务。</p>{error&&<Alert id="service-error" role="alert" type="error" showIcon title={error}/>}<Button htmlType="submit" type="primary" size="large" block>进入工作区<ArrowRightOutlined/></Button>{destination&&<p className="entry-destination">即将前往 <strong>{destination}</strong></p>}{storageNote&&<p role="status" className="entry-field-help">{storageNote}</p>}</form><div className="entry-service-note"><i/>{configured?'已提供默认服务地址，也可连接其他工作区。':'尚未设置默认服务。已有部署可直接填写地址；首次部署请查看部署指南。'}</div><div className="entry-demo"><div><strong>先了解产品？</strong><p>独立本地演示，已有浏览器数据可继续查看。</p></div><a href={demoHref}>打开演示<ArrowRightOutlined/></a></div></section>
  </main><footer className="entry-footer"><span>真实协作由所连接的服务器提供 · 此入口不接收密码或项目资料</span><a href="https://github.com/WangFei-2019/cobuild" target="_blank" rel="noopener noreferrer">GitHub 源码</a></footer>
 </div>;
}
createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#2f7c67',colorText:'#182b36',colorTextSecondary:'#68766f',colorBorder:'#dce3de',borderRadius:8,controlHeightLG:46,fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'}}}><ServiceEntry/></ConfigProvider>);
