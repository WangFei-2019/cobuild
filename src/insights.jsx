import React, {useEffect, useMemo, useRef, useState} from 'react';
import {App as AntApp, Alert, Button, Empty, Input, Modal, Pagination, Segmented, Select, Space, Tabs, Tag} from 'antd';
import {ArrowRightOutlined, CheckCircleOutlined, CopyOutlined, DownloadOutlined, FileTextOutlined, ReloadOutlined, RobotOutlined, SafetyCertificateOutlined} from '@ant-design/icons';
import {buildAssistantContext, deriveProjectInsights} from '../insights.mjs';
import {buildPlanningPrompt} from '../ai-exchange.mjs';
import {canManage, isDemo} from './lib.js';
import './insights.css';
import {DraftNotice,useRecoverableDraft} from './draft-store.jsx';

function saveText(text, name) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], {type:'text/plain;charset=utf-8'}));
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileName = value => String(value || '项目').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80);

export default function ProjectInsights({data, onOpen, onPlan, onReplan, onTool, onDirty}) {
  const {message, modal} = AntApp.useApp();
  const insights = useMemo(() => deriveProjectInsights(data), [data]);
  const [tab, setTab] = useState('health');
  const [filter, setFilter] = useState('all');
  const [signalPage, setSignalPage] = useState(1);
  const [mode, setMode] = useState(data.tasks.length ? 'replan' : 'initial');
  const [request, setRequest] = useState('');
  const [brief, setBrief] = useState(insights.brief.markdown);
  const [briefRevision, setBriefRevision] = useState(data.revision);
  const [edited, setEdited] = useState(false);
  const [copyFallback, setCopyFallback] = useState(null);
  const dirtyCallback = useRef(onDirty); dirtyCallback.current = onDirty;
  const writable=Boolean(data.currentMemberId)||canManage(data);
  const briefDraft=useRecoverableDraft({projectId:data.project.id,form:'brief',version:data.revision,canWrite:writable,onRestore:(value,saved)=>{setBrief(value.text||'');setBriefRevision(saved.baseVersion);setEdited(true);setTab('brief');}});
  const requestDraft=useRecoverableDraft({projectId:data.project.id,form:'ai-request',version:data.revision,canWrite:writable,onRestore:value=>{setRequest(value.text||'');setMode(value.mode==='initial'?'initial':'replan');setTab('ai');}});
  useEffect(() => {dirtyCallback.current?.(edited||Boolean(request.trim())); return () => dirtyCallback.current?.(false);}, [edited,request]);
  useEffect(() => {if (!edited) {setBrief(insights.brief.markdown); setBriefRevision(data.revision);}}, [data.revision, insights.brief.markdown, edited]);
  async function copy(text, label) {
    try {await navigator.clipboard.writeText(text); message.success(`${label}已复制`);}
    catch {setCopyFallback({text, label});}
  }
  function regenerate() {
    const run = () => {briefDraft.clear();setBrief(insights.brief.markdown); setBriefRevision(data.revision); setEdited(false);};
    if (edited) modal.confirm({title:'用当前项目记录重新整理？',content:'重新整理会替换你对这份简报的编辑。可以先复制或下载保留。',okText:'重新整理',cancelText:'保留当前编辑',onOk:run});
    else run();
  }
  const selected = insights.signals.filter(item => filter === 'all' || (filter === 'risk' ? item.severity === 'risk' : item.severity !== 'risk'));
  const page=Math.min(signalPage,Math.max(1,Math.ceil(selected.length/8)));
  const visibleSignals=selected.slice((page-1)*8,page*8);
  const promptResult = useMemo(() => {try{return {value:buildPlanningPrompt(data,{mode,today:insights.today,request:{constraints:request}}),error:''};}catch(error){return {value:'',error:error.message||'项目上下文过长，暂时无法生成规划提示词。'};}},[data,mode,request,insights.today]);
  const planningPrompt=promptResult.value;
  const riskCount = insights.signals.filter(item => item.severity === 'risk').length;
  const toolMember=data.members.find(member=>member.id===data.currentMemberId);
  const canRunTools=toolMember&&toolMember.active!==false&&toolMember.accessRole!=='viewer'&&!data.permissions?.readOnly;
  const planAction=mode==='initial'?onPlan:onReplan;
  const tools=[{mode:'weekly',title:'有来源的周报',description:'指定时间范围，核对引用记录，再编辑与复制。',button:'整理周报',icon:<FileTextOutlined/>},{mode:'actions',title:'讨论 / 纪要转行动',description:'选择讨论或粘贴纪要，逐项确认后建立任务。',button:'提取行动',icon:<RobotOutlined/>},{mode:'check',title:'交付完整性检查',description:'对照交付要求找缺项和待验证材料，由接收人验收。',button:'检查交付',icon:<CheckCircleOutlined/>}];
  function copyFacts(){try{copy(buildAssistantContext(data),'项目事实上下文');}catch(error){message.error(error.message||'暂时无法整理项目上下文');}}
  const assistant = <div className="copilot-tools">
    {typeof onTool==='function'&&canRunTools&&<section className="copilot-tool-section"><div className="copilot-section-heading"><div><h3>AI 协作工具</h3><p>打开工具后确认资料范围与账号可用服务；生成结果均需人工核对。</p></div></div><div className="copilot-tool-list">{tools.map(tool=><article className="copilot-tool-row" key={tool.mode}><span className="copilot-tool-icon">{tool.icon}</span><div><h4>{tool.title}</h4><p>{tool.description}</p></div><Button onClick={()=>onTool(tool.mode)}>{tool.button}</Button></article>)}</div></section>}
    <section className="copilot-tool-section"><div className="copilot-section-heading"><div><h3>项目规划</h3><p>建立新的阶段与分工，或保留已有成果、调整剩余计划。</p></div></div><div className="copilot-planning-controls"><Select aria-label="AI 协作类型" value={mode} onChange={value=>{setMode(value);if(request.trim())requestDraft.update({text:request,mode:value});}} options={[{value:'initial',label:'建立新的里程碑与任务'},{value:'replan',label:'调整剩余计划，保留已有成果'}]}/>{typeof planAction==='function'&&<Button type="primary" disabled={!canManage(data)} icon={<RobotOutlined/>} onClick={()=>planAction()}>{isDemo?'打开内置规划示例':'打开 AI 规划'}</Button>}</div>{!canManage(data)&&<p className="copilot-description">可准备和导出规划资料，应用计划由项目管理员确认。</p>}
      <details className="copilot-external" open={request.trim()?true:undefined}><summary>使用外部 AI 导入规划</summary><div className="copilot-external-body"><p className="copilot-description">此处不调用模型。核对提示词后交给自选 AI，再导入结构化草案；确认前不会改变项目。</p><DraftNotice draft={requestDraft} label="外部AI请求"/><label className="copilot-field-label" htmlFor="copilot-request">本次目标与约束</label><Input.TextArea id="copilot-request" aria-label="这次希望 AI 帮助什么" value={request} onChange={event=>{setRequest(event.target.value);if(event.target.value.trim())requestDraft.update({text:event.target.value,mode});else requestDraft.clear();}} rows={3} maxLength={3000} placeholder="例如：保留已交付成果，优先解决接口阻塞，调整下一周的安排。"/>{promptResult.error&&<Alert type="warning" showIcon title="暂时无法生成完整规划提示词" description={<><p>{promptResult.error}</p><p>体检和简报仍可使用；也可复制下方的受限项目事实，与 AI 明确本次讨论范围。</p></>}/>}
      <details className="copilot-context-preview"><summary>预览将复制的项目资料与输出格式</summary><Input.TextArea aria-label="规划提示词预览" readOnly value={planningPrompt||promptResult.error} rows={14}/></details><Space wrap><Button icon={<CopyOutlined/>} disabled={Boolean(promptResult.error)} onClick={()=>copy(planningPrompt,'规划提示词')}>复制规划提示词</Button><Button icon={<DownloadOutlined/>} disabled={Boolean(promptResult.error)} onClick={()=>saveText(planningPrompt,`${fileName(data.project.name)}-AI规划提示词.txt`)}>下载提示词</Button>{typeof planAction==='function'&&<Button disabled={!canManage(data)} icon={<FileTextOutlined/>} onClick={()=>planAction('import')}>导入{mode==='initial'?'新规划':'调整方案'} <ArrowRightOutlined/></Button>}</Space></div></details>
    </section>
    <div className="copilot-context-footer"><Button icon={<CopyOutlined/>} onClick={copyFacts}>仅复制项目事实</Button><details><summary>资料范围与应用规则</summary><p>仅整理当前项目的事实与关联规则，不附带文件正文。复制前请核对预览；外部模型由你选择。</p><p>规划导入会校验成员、日期、依赖和来源版本。已交付任务与已验收阶段受到保护，应用前需独立确认。</p></details></div>
  </div>;
  return <section className="copilot-page">
    <header className="copilot-intro"><h2>项目副驾</h2><span>核对当前记录，整理同步与下一步。</span><Tag>项目 v{data.revision}</Tag></header>
    <Tabs activeKey={tab} onChange={setTab} className="copilot-tabs" items={[
      {key:'health',label:<span><SafetyCertificateOutlined/> 项目体检 <small>{insights.signals.length}</small></span>,children:<>
        <div className="copilot-health-summary"><div><span className={`prj-health-dot ${insights.health.status}`}/><strong>{insights.health.label}</strong><p>{insights.health.summary}</p></div><span>规则检查 · {insights.today}</span></div>
        <dl className="copilot-fact-list"><div><dt>完整交接记录</dt><dd>{insights.counts.verifiedDone}<small> / {insights.counts.total}</small></dd></div><div><dt>待验收</dt><dd>{insights.counts.review}</dd></div><div><dt>已逾期</dt><dd>{insights.counts.overdue}</dd></div><div><dt>缺交付约定</dt><dd>{insights.counts.missingDeliverable}</dd></div><div><dt>缺有效负责人</dt><dd>{insights.counts.missingOwner}</dd></div></dl>
        <section className="copilot-signals"><div className="copilot-section-heading"><div><h3>值得核对的信号</h3><p>{riskCount} 条风险；同一任务可能触发多条规则。</p></div><Segmented aria-label="体检信号筛选" value={filter} onChange={value=>{setFilter(value);setSignalPage(1);}} options={[{value:'all',label:'全部'},{value:'risk',label:'风险'},{value:'attention',label:'其他提醒'}]}/></div>{visibleSignals.length?visibleSignals.map(signal=><article className={`copilot-signal ${signal.severity}`} key={signal.id}><div className="copilot-signal-heading"><Tag color={signal.severity==='risk'?'warning':signal.severity==='attention'?'purple':undefined}>{signal.priority==='high'?'优先关注':'核对提醒'}</Tag><h4>{signal.title}</h4>{signal.taskId&&typeof onOpen==='function'&&<Button type="text" size="small" onClick={()=>onOpen(signal.taskId)}>查看任务 <ArrowRightOutlined/></Button>}</div>{signal.taskTitle&&<p className="copilot-signal-origin">{signal.taskCode} · {signal.taskTitle}</p>}<p className="copilot-action"><span>建议</span>{signal.action}</p><details className="copilot-evidence"><summary>查看依据（{signal.evidence.length}）</summary><ul>{signal.evidence.map((value,index)=><li key={index}>{value}</li>)}</ul></details></article>):<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下没有规则提醒"/>}{selected.length>8&&<Pagination className="copilot-pagination" size="small" current={page} pageSize={8} total={selected.length} showSizeChanger={false} showTotal={total=>`共 ${total} 条`} onChange={setSignalPage}/>}</section>
        <details className="copilot-method"><summary>体检范围与判断方式</summary><p>根据当前状态、期限、分工、依赖和交接记录逐项检查。每条信号可展开依据；信息不足时保留未知。这些数量不代表工作量或质量，不预测完成日期。</p></details>
      </>},
      {key:'brief',label:<span><FileTextOutlined/> 项目简报</span>,children:<section className="copilot-brief"><div className="copilot-section-heading"><div><h3>按当前记录整理的简报草稿</h3><p>规则整理，不调用模型；可编辑后复制或下载。</p></div><Tag>来源 v{briefRevision}</Tag></div>{briefRevision!==data.revision&&<Alert type="warning" showIcon title="项目记录已更新，当前编辑仍保留" description="核对最新记录后，再决定是否重新整理。"/>}<DraftNotice draft={briefDraft} label="简报"/><Input.TextArea className="copilot-brief-editor" aria-label="编辑项目简报草稿" value={brief} onChange={event=>{setBrief(event.target.value);setEdited(true);briefDraft.update({text:event.target.value},briefRevision);}} rows={20} maxLength={40000}/><div className="copilot-brief-actions"><span>{edited?'已编辑 · 本浏览器草稿自动保存':'当前快照 · 尚未编辑'}</span><Space wrap><Button icon={<ReloadOutlined/>} onClick={regenerate}>重新整理</Button><Button icon={<DownloadOutlined/>} onClick={()=>saveText(brief,`${fileName(data.project.name)}-项目简报.md`)}>下载 Markdown</Button><Button type="primary" icon={<CopyOutlined/>} onClick={()=>copy(brief,'项目简报')}>复制简报</Button></Space></div><details className="copilot-method"><summary>草稿内容与保存方式</summary><p>包括已交付、进行中、受阻、下一步和待确认五部分，并附真实记录依据。不会自动发布或承诺进度。本浏览器草稿保留7天，换设备前请复制或下载。</p></details></section>},
      {key:'ai',label:<span><RobotOutlined/> 工具与 AI</span>,children:assistant},
    ]}/>
    <Modal open={Boolean(copyFallback)} title={copyFallback?.label || '复制内容'} onCancel={() => setCopyFallback(null)} footer={<Button type="primary" onClick={() => setCopyFallback(null)}>已保留内容</Button>}><p>浏览器没有允许自动复制，可以在下方全选后手动复制。</p><Input.TextArea aria-label="待手动复制的内容" readOnly value={copyFallback?.text || ''} rows={16}/></Modal>
  </section>;
}
