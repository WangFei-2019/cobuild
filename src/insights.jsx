import React, {useEffect, useMemo, useRef, useState} from 'react';
import {App as AntApp, Alert, Button, Empty, Input, Modal, Segmented, Select, Space, Tabs, Tag} from 'antd';
import {ArrowRightOutlined, CheckCircleOutlined, CopyOutlined, DownloadOutlined, FileTextOutlined, ReloadOutlined, RobotOutlined, SafetyCertificateOutlined} from '@ant-design/icons';
import {buildAssistantContext, deriveProjectInsights} from '../insights.mjs';
import {buildPlanningPrompt} from '../ai-exchange.mjs';
import {canManage, isDemo} from './lib.js';
import './insights.css';

function saveText(text, name) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], {type:'text/plain;charset=utf-8'}));
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileName = value => String(value || '项目').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80);

export default function ProjectInsights({data, onOpen, onPlan, onReplan, onDirty}) {
  const {message, modal} = AntApp.useApp();
  const insights = useMemo(() => deriveProjectInsights(data), [data]);
  const [tab, setTab] = useState('health');
  const [filter, setFilter] = useState('all');
  const [mode, setMode] = useState(data.tasks.length ? 'replan' : 'initial');
  const [request, setRequest] = useState('');
  const [brief, setBrief] = useState(insights.brief.markdown);
  const [briefRevision, setBriefRevision] = useState(data.revision);
  const [edited, setEdited] = useState(false);
  const [copyFallback, setCopyFallback] = useState(null);
  const dirtyCallback = useRef(onDirty); dirtyCallback.current = onDirty;
  useEffect(() => {dirtyCallback.current?.(edited||Boolean(request.trim())); return () => dirtyCallback.current?.(false);}, [edited,request]);
  useEffect(() => {if (!edited) {setBrief(insights.brief.markdown); setBriefRevision(data.revision);}}, [data.revision, insights.brief.markdown, edited]);
  async function copy(text, label) {
    try {await navigator.clipboard.writeText(text); message.success(`${label}已复制`);}
    catch {setCopyFallback({text, label});}
  }
  function regenerate() {
    const run = () => {setBrief(insights.brief.markdown); setBriefRevision(data.revision); setEdited(false);};
    if (edited) modal.confirm({title:'用当前项目记录重新整理？',content:'重新整理会替换你对这份简报的编辑。可以先复制或下载保留。',okText:'重新整理',cancelText:'保留当前编辑',onOk:run});
    else run();
  }
  const selected = insights.signals.filter(item => filter === 'all' || (filter === 'risk' ? item.severity === 'risk' : item.severity !== 'risk'));
  const promptResult = useMemo(() => {try{return {value:buildPlanningPrompt(data,{mode,today:insights.today,request:{constraints:request}}),error:''};}catch(error){return {value:'',error:error.message||'项目上下文过长，暂时无法生成规划提示词。'};}},[data,mode,request,insights.today]);
  const planningPrompt=promptResult.value;
  const riskCount = insights.signals.filter(item => item.severity === 'risk').length;
  const assistant = <div className="copilot-ai-layout">
    <section className="copilot-panel copilot-workflow">
      <div className="copilot-section-heading"><div><span className="copilot-eyebrow">AI，带着项目上下文一起工作</span><h3>把建议带回来，变成可确认的计划</h3></div><RobotOutlined/></div>
      <p className="copilot-description">把你确认过的项目资料交给自己选择的 AI，再把结构化方案带回共建。应用前会检查分工、日期、依赖和已有成果保护。</p>{promptResult.error&&<Alert type="warning" showIcon title="这份项目资料暂时无法生成完整规划提示词" description={<><p>{promptResult.error}</p><p>项目体检和简报仍可使用，也可以先复制右侧的受限项目事实上下文，与 AI 明确本次讨论范围。</p></>} style={{marginBottom:22}}/>}
      <ol className="copilot-steps">
        <li><span>01</span><div><strong>准备这一次的规划目标</strong><p>已有工作会保留；调整方案必须明确关联原任务。</p><Select aria-label="AI 协作类型" value={mode} onChange={setMode} options={[{value:'initial',label:'建立新的里程碑与任务'},{value:'replan',label:'调整剩余计划，保留已有成果'}]}/><Input.TextArea aria-label="这次希望 AI 帮助什么" value={request} onChange={event => setRequest(event.target.value)} rows={3} maxLength={3000} placeholder="例如：保持已有成果，优先解决接口阻塞，重新安排接下来一周的交付。"/></div></li>
        <li><span>02</span><div><strong>查看资料，再复制给你选择的 AI</strong><p>包含目标、成员、任务和所需输出格式。文件正文不会随提示词附带；请先核对下面的资料预览。</p><details className="copilot-context-preview" style={{marginBottom:14}}><summary>查看将要复制的规划提示词</summary><Input.TextArea aria-label="规划提示词预览" readOnly value={planningPrompt||promptResult.error} rows={18}/></details><Space wrap><Button type="primary" icon={<CopyOutlined/>} disabled={Boolean(promptResult.error)} onClick={() => copy(planningPrompt, '规划提示词')}>复制规划提示词</Button><Button icon={<DownloadOutlined/>} disabled={Boolean(promptResult.error)} onClick={() => saveText(planningPrompt, `${fileName(data.project.name)}-AI规划提示词.txt`)}>下载</Button></Space></div></li>
        <li><span>03</span><div><strong>导入草案，核对后再应用</strong><p>AI 输出不能直接改动项目。导入后校验，保留人工修改与独立确认步骤。</p><Button icon={<FileTextOutlined/>} disabled={!canManage(data)} onClick={() => mode === 'initial' ? onPlan?.('import') : onReplan?.('import')}>导入{mode === 'initial' ? '新规划' : '调整方案'} <ArrowRightOutlined/></Button>{!canManage(data) && <p>规划的应用由项目管理员确认。</p>}</div></li>
      </ol>
    </section>
    <aside className="copilot-ai-aside">
      <section className="copilot-panel copilot-boundary"><SafetyCertificateOutlined/><h3>每一次变更，都由你确认</h3><p>{isDemo ? '当前演示不连接模型，也不会自动发送项目资料。你决定复制哪些资料、使用哪个 AI。' : '复制提示词不会调用模型。直接 AI 规划使用工作区配置的服务，在规划窗口中单独发起。'}</p><ul><li>事实与假设分开呈现</li><li>已有成果与已验收阶段受到保护</li><li>未知成员、循环依赖和无效日期会被拒绝</li><li>确认应用前，项目保持原样</li></ul><Space direction="vertical" style={{width:'100%'}}><Button block onClick={() => mode === 'replan' ? onReplan?.() : onPlan?.()} disabled={!canManage(data)}>{isDemo ? mode === 'replan' ? '体验内置调整示例' : '体验内置规划示例' : mode === 'replan' ? '使用工作区 AI 调整计划' : '使用工作区 AI 规划'}</Button><Button block onClick={() => copy(buildAssistantContext(data), '项目事实上下文')}>仅复制项目事实</Button></Space></section>
    </aside>
  </div>;
  return <section className="copilot-page">
    <header className="copilot-intro"><span className="copilot-intro-icon"><RobotOutlined/></span><div><span className="copilot-eyebrow">从项目事实，到下一步行动</span><h2>项目副驾</h2><p>解释风险，整理进展，让每个建议都有可以回看的依据。</p></div><Tag>本地分析 · 不调用模型</Tag></header>
    <Tabs activeKey={tab} onChange={setTab} className="copilot-tabs" items={[
      {key:'health',label:<span><SafetyCertificateOutlined/> 项目体检 <small>{insights.signals.length}</small></span>,children:<>
        <div className="copilot-health-summary"><div><span className={`prj-health-dot ${insights.health.status}`}/><strong>{insights.health.label}</strong><p>{insights.health.summary}</p></div><span>依据当前记录 · {insights.today}<br/>不预测工时或完成日期</span></div>
        <div className="copilot-diagnostic-grid"><div className="copilot-panel copilot-signals"><div className="copilot-section-heading"><div><h3>值得处理的信号</h3><p>{riskCount} 条风险信号；同一任务可能触发多条规则。</p></div><Segmented aria-label="体检信号筛选" value={filter} onChange={setFilter} options={[{value:'all',label:'全部'},{value:'risk',label:'风险'},{value:'attention',label:'其他提醒'}]}/></div>{selected.length ? selected.map(signal => <article className={`copilot-signal ${signal.severity}`} key={signal.id}><div className="copilot-signal-heading"><Tag color={signal.severity === 'risk' ? 'warning' : signal.severity === 'attention' ? 'purple' : undefined}>{signal.priority === 'high' ? '优先关注' : '核对提醒'}</Tag><h4>{signal.title}</h4>{signal.taskId && <Button type="text" size="small" onClick={() => onOpen(signal.taskId)}>查看任务 <ArrowRightOutlined/></Button>}</div>{signal.taskTitle && <p className="copilot-signal-origin">{signal.taskCode} · {signal.taskTitle}</p>}<div className="copilot-evidence"><strong>依据</strong><ul>{signal.evidence.map((value, index) => <li key={index}>{value}</li>)}</ul></div><p className="copilot-action"><span>下一步</span>{signal.action}</p></article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下没有规则提醒"/>}</div>
        <aside><section className="copilot-panel"><div className="copilot-section-heading"><h3>交接与约定</h3><CheckCircleOutlined/></div><dl className="copilot-fact-list"><div><dt>已有完整交接记录</dt><dd>{insights.counts.verifiedDone}<small> / {insights.counts.total}</small></dd></div><div><dt>等待成果验收</dt><dd>{insights.counts.review}</dd></div><div><dt>超过任务期限</dt><dd>{insights.counts.overdue}</dd></div><div><dt>未约定交付物</dt><dd>{insights.counts.missingDeliverable}</dd></div><div><dt>缺少有效负责人</dt><dd>{insights.counts.missingOwner}</dd></div></dl><p className="copilot-footnote">任务数量不代表工作量，也不能替代成果质量检查。</p></section><section className="copilot-note"><h4>这些观察如何产生？</h4><p>用记录中的状态、期限、分工、依赖和验收条件逐项检查。每条信号都列出依据，信息缺失时保留未知。</p><p>需要语言模型帮助取舍或重排时，切换到“与 AI 共建”。</p><Button type="text" onClick={() => setTab('ai')}>带着上下文继续规划 <ArrowRightOutlined/></Button></section></aside></div>
      </>},
      {key:'brief',label:<span><FileTextOutlined/> 项目简报</span>,children:<div className="copilot-brief-layout"><section className="copilot-panel"><div className="copilot-section-heading"><div><h3>一份可以继续编辑的项目简报</h3><p>基于当前快照整理，不自动发布或替你承诺进度。</p></div><Tag>项目 v{briefRevision}</Tag></div>{briefRevision !== data.revision && <Alert type="warning" showIcon title="项目记录已更新，当前简报编辑仍保留" description="核对最新记录后，再决定是否重新整理。" style={{marginBottom:16}}/>}<Input.TextArea className="copilot-brief-editor" aria-label="编辑项目简报草稿" value={brief} onChange={event => {setBrief(event.target.value); setEdited(true);}} rows={23} maxLength={40000}/><div className="copilot-brief-actions"><span>{edited ? '编辑内容暂存于本页，请复制或下载保留' : '按当前记录整理的草稿'}</span><Space wrap><Button icon={<ReloadOutlined/>} onClick={regenerate}>重新整理</Button><Button icon={<DownloadOutlined/>} onClick={() => saveText(brief, `${fileName(data.project.name)}-项目简报.md`)}>下载 Markdown</Button><Button type="primary" icon={<CopyOutlined/>} onClick={() => copy(brief, '项目简报')}>复制简报</Button></Space></div></section><aside className="copilot-note"><span className="copilot-eyebrow">一次有用的项目同步</span><h3>说清楚五件事</h3><ol><li>已经交付了什么？</li><li>正在推进什么？</li><li>哪里受阻，需要谁帮助？</li><li>接下来先做什么？</li><li>哪些事情仍需确认？</li></ol><p>草稿附带记录依据。复制后可继续在团队原有沟通工具里同步，保留你自己的判断。</p><p>这份编辑暂存于当前页面，离开前请复制或下载。</p></aside></div>},
      {key:'ai',label:<span><RobotOutlined/> 与 AI 共建</span>,children:assistant},
    ]}/>
    <Modal open={Boolean(copyFallback)} title={copyFallback?.label || '复制内容'} onCancel={() => setCopyFallback(null)} footer={<Button type="primary" onClick={() => setCopyFallback(null)}>已保留内容</Button>}><p>浏览器没有允许自动复制，可以在下方全选后手动复制。</p><Input.TextArea aria-label="待手动复制的内容" readOnly value={copyFallback?.text || ''} rows={16}/></Modal>
  </section>;
}
