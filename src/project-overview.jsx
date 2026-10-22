import React,{useState} from 'react';
import {Button, Collapse, Empty, Progress, Tag} from 'antd';
import {ArrowRightOutlined, CheckCircleOutlined, EditOutlined, FlagOutlined, PlusOutlined, TeamOutlined} from '@ant-design/icons';
import {deriveProjectInsights} from '../insights.mjs';
import {activeMembers, canCreate, canManage, dateLabel, safeColor, taskIsOpen} from './lib.js';
import {ActivityList, Person, StatusTag} from './shared.jsx';

export default function ProjectOverview({state, onOpen, onTab, onNewTask, onAddMember, onEdit, onPlan}) {
  const insight = deriveProjectInsights(state);
  const {counts, health} = insight;
  const [moreDecisions,setMoreDecisions]=useState(false);
  const members=activeMembers(state),phases=insight.milestones.slice(0,3),decisions=moreDecisions?state.decisions:state.decisions?.slice(0,2);
  const complete = counts.total ? Math.round(counts.verifiedDone / counts.total * 100) : 0;
  const taskIds = [...new Set(insight.suggestions.map(item => item.taskId).filter(Boolean))];
  const ordered = [...taskIds.map(id => state.tasks.find(task => task.id === id)), ...state.tasks.filter(taskIsOpen)]
    .filter((task, index, all) => task && task.status!=='canceled' && all.findIndex(item => item?.id === task.id) === index).slice(0, 4);
  const missing = !state.project.goal ? {title:'先让大家对结果有相同的理解', text:'写清楚这次准备交付什么、由谁确认，让后续分工有共同的依据。', action:'补充共同目标', run:onEdit}
    : !state.milestones?.length ? {title:'给目标一个可以验收的阶段', text:'先约定第一个阶段的结果和检查标准，再把它拆成具体任务。', action:'制定第一个里程碑', run:() => onTab('milestones')}
    : !state.tasks.length ? {title:'把第一个阶段落到一个人和一份成果', text:'创建一项有负责人、接收人和交付约定的任务，开始实际推进。', action:'建立第一项分工', run:onNewTask} : null;
  return <div className="prj-overview">
    <section className="prj-outcome">
      <div className="prj-outcome-copy">
        <span className="prj-eyebrow">共同目标 / OUTCOME</span>
        <h2>{state.project.goal || '一个共同的目标，值得一起做好。'}</h2>
        <p>{state.project.description || '补充项目背景，让伙伴知道为什么开始、准备解决什么问题。'}</p>
        <div className="prj-outcome-actions"><Button icon={<EditOutlined/>} disabled={!canManage(state)} onClick={onEdit}>完善项目约定</Button><Button type="text" onClick={() => onTab('insights')}>打开项目副驾 <ArrowRightOutlined/></Button></div>
      </div>
      <div className="prj-result-score">
        <div className="prj-health-line"><span className={`prj-health-dot ${health.status}`}/><strong>{health.label}</strong></div>
        <div className="prj-result-number">{counts.verifiedDone}<span>/ {counts.total}</span></div>
        <p>任务已有完整交接记录</p>
        <Progress percent={complete} showInfo={false} strokeColor="#2f7c67" trailColor="#dce8e1"/>
        <small>{counts.total ? '按任务数量计数，成果质量仍需人工检查。' : '建立任务后显示交付进度。'}</small>
      </div>
    </section>
    {missing && <section className="prj-start-guide"><span className="prj-guide-icon"><FlagOutlined/></span><div><h3>{missing.title}</h3><p>{missing.text}</p></div><Button type="primary" disabled={!canManage(state)} onClick={missing.run}>{missing.action} <ArrowRightOutlined/></Button></section>}
    <div className="prj-overview-columns">
      <div className="prj-overview-primary">
        <section className="prj-panel">
          <div className="prj-section-heading"><div><h2>当前需关注的任务</h2></div><Button type="text" onClick={() => onTab('tasks')}>全部任务 <ArrowRightOutlined/></Button></div>
          {ordered.length ? <div className="prj-focus-list">{ordered.map(task => <button className="prj-focus-task" key={task.id} onClick={() => onOpen(task.id)}><span className={`prj-task-indicator ${task.status}`}><CheckCircleOutlined/></span><span className="prj-focus-task-copy"><span className="prj-task-code">{task.code}</span><strong>{task.title}</strong><span className="prj-task-description">{task.status === 'blocked' ? task.blocker || '请补充需要的帮助' : task.status === 'review' ? '已提交成果，等待约定接收人检查' : task.deliverable || '交付约定待补充'}</span><span className="prj-focus-task-meta"><Person id={task.ownerId} members={state.members} size={20}/><span>{task.due ? `${dateLabel(task.due)} 截止` : '期限待约定'}</span></span></span><span className="prj-focus-task-end"><StatusTag value={task.status}/><ArrowRightOutlined/></span></button>)}</div>
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={state.tasks.some(task=>task.status!=='canceled') ? '当前有效任务已标记完成，继续核对阶段验收。' : state.tasks.length ? '当前任务均已取消，可查看历史或重新安排分工。' : '还没有任务，从一份具体交付开始。'}><Button type="primary" icon={<PlusOutlined/>} disabled={!canCreate(state)} onClick={onNewTask}>新建任务</Button></Empty>}
          <p className="prj-footnote">顺序依据受阻、期限与待交接记录整理，可在副驾中查看具体依据。</p>
        </section>
        <section className="prj-panel">
          <div className="prj-section-heading"><div><h2>阶段交付</h2></div><Button type="text" onClick={() => onTab('milestones')}>查看里程碑 <ArrowRightOutlined/></Button></div>
          {insight.milestones.length ? <div className="prj-phase-list">{phases.map((phase, index) => <button className={`prj-phase ${phase.status === 'accepted' ? 'accepted' : ''}`} key={phase.id || index} onClick={() => onTab('milestones')}><span className="prj-phase-step">{phase.status === 'accepted' ? <CheckCircleOutlined/> : String(index + 1).padStart(2, '0')}</span><span className="prj-phase-copy"><strong>{phase.title}</strong><span>{phase.due ? `${dateLabel(phase.due)} 计划交付` : '阶段日期待约定'} · {phase.verifiedDone}/{phase.total} 项已有交接记录</span><Progress percent={phase.total ? Math.round(phase.verifiedDone / phase.total * 100) : 0} showInfo={false} strokeColor="#2f7c67"/></span><Tag color={phase.status === 'accepted' ? 'success' : undefined}>{phase.status === 'accepted' ? '已记录验收' : phase.total && phase.verifiedDone === phase.total ? '等待阶段验收' : '推进中'}</Tag></button>)}</div>
            : <div className="prj-empty-route"><FlagOutlined/><div><strong>让阶段完成有明确的判断标准</strong><p>里程碑把一组任务连接成可检查的结果。</p></div><Button disabled={!canManage(state)} onClick={onPlan}>协助制定规划</Button></div>}
          {insight.milestones.length>phases.length&&<p className="prj-preview-note">展示前 {phases.length} 个阶段，完整计划请查看里程碑。</p>}
        </section>
        <section className="prj-panel"><div className="prj-section-heading"><div><h2>最近动态</h2></div><Button type="text" onClick={() => onTab('activity')}>全部动态 <ArrowRightOutlined/></Button></div><ActivityList activities={(state.activities || []).slice(0, 3)} state={state} onOpen={onOpen}/></section>
      </div>
      <aside className="prj-overview-aside">

        <section className="prj-panel"><div className="prj-section-heading"><h2>成员与分工</h2><Button type="text" size="small" onClick={() => onTab('members')} aria-label="查看项目成员"><TeamOutlined/></Button></div><div className="prj-team-list">{members.slice(0,5).map(person => <div className="prj-team-person" key={person.id}><Person id={person.id} members={state.members} size={32}/><span><small>{person.role || '项目协作者'}</small><strong>{state.tasks.filter(task => task.ownerId === person.id && taskIsOpen(task)).length} 项负责未完成</strong></span></div>)}</div>{members.length>5&&<Button block type="text" onClick={()=>onTab('members')}>查看全部 {members.length} 位成员 <ArrowRightOutlined/></Button>}{state.permissions?.manageMembers!==false&&<Button block icon={<PlusOutlined/>} disabled={!canManage(state)} onClick={onAddMember}>添加伙伴</Button>}</section>
        {state.decisions?.length > 0 && <section className="prj-panel"><div className="prj-section-heading"><h2>项目约定</h2><span className="prj-muted">{state.decisions.length} 条</span></div><Collapse className="prj-decision-preview" ghost size="small" items={decisions.map(decision=>({key:decision.id,label:decision.title,children:<p>{decision.detail}</p>}))}/>{state.decisions.length>2&&<Button type="link" size="small" onClick={()=>setMoreDecisions(value=>!value)}>{moreDecisions?'收起约定':`查看其余 ${state.decisions.length-2} 条约定`}</Button>}</section>}
      </aside>
    </div>
  </div>;
}
