import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Alert,Avatar,Button,Card,ColorPicker,Dropdown,Empty,Form,Input,Modal,Select,Space,Table,Tabs,Tag,Typography} from 'antd';
import {ArrowRightOutlined,CopyOutlined,EditOutlined,EllipsisOutlined,LinkOutlined,PlusOutlined,SearchOutlined,TeamOutlined,UserAddOutlined} from '@ant-design/icons';
import {api,isDemo,canManage,dateLabel,safeColor,contrastColor,avatarInitial} from './lib.js';
import {navigate} from './router.js';
import {Person} from './shared.jsx';
import './people.css';

const {Text}=Typography;
const accessOptions=[{value:'admin',label:'项目管理员'},{value:'member',label:'项目成员'},{value:'viewer',label:'只读成员'}];
const colors=['#28577b','#427b68','#7770a3','#b47e59','#9a5d75','#6387a2'];
const normalizedName=value=>String(value||'').trim().normalize('NFKC').toLocaleLowerCase();
const briefBio=value=>{const chars=[...String(value||'').trim()];return chars.length>60?chars.slice(0,59).join('')+'…':chars.join('');};
const shortPersonId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{9,}$/.test(value)?value.slice(-8):'';
function PersonChoice({person,disambiguate=false}) {
  const shortId=disambiguate?shortPersonId(person.id):'',bio=briefBio(person.bio);
  return <Space align="start" size={10} style={{maxWidth:'100%'}}>
    <Avatar size={30} style={{background:safeColor(person.color),color:contrastColor(person.color),flexShrink:0}}>{avatarInitial(person)}</Avatar>
    <div style={{minWidth:0,whiteSpace:'normal',overflowWrap:'anywhere'}}>
      <Space size={6} wrap><strong>{person.name}</strong><Text type="secondary">{person.accountLinked?(isDemo?'本地体验身份':'平台账号'):'人员档案'}</Text>{shortId&&<Text type="secondary">辨识码 · {shortId}</Text>}</Space>
      <Text type="secondary" style={{display:'block'}}>{bio||'尚未填写人员简介'}</Text>
    </div>
  </Space>;
}

export function PersonProfileModal({person=null,revision,onClose,onSubmit}) {
  const {message,modal}=AntApp.useApp(),[form]=Form.useForm(),[saving,setSaving]=useState(false);
  const [version,setVersion]=useState(revision),[conflict,setConflict]=useState(null),[nameTaken,setNameTaken]=useState(false);
  const pending=useRef(false);
  async function save(values,allowDuplicateName=false) {
    if(pending.current)return;
    pending.current=true;setSaving(true);setNameTaken(false);
    try {
      await onSubmit(values,{expectedRevision:version,allowDuplicateName});
      onClose();
    } catch(error) {
      if(error.status===409&&error.code==='NAME_TAKEN') {
        setNameTaken(true);form.setFields([{name:'name',errors:['该昵称已被占用']}]);form.scrollToField('name',{focus:true});
      } else if(error.code==='DUPLICATE_PERSON_NAME'&&!allowDuplicateName) {
        modal.confirm({title:'目录中已有同名人员',content:'如果是同一位伙伴，请取消并选择已有档案。若确认是不同的人，可以保留独立档案，历史记录不会合并。',
          okText:'确认是不同人员',cancelText:'返回核对',onOk:()=>save(values,true)});
      } else if(error.status===409&&person) {
        try {const latest=await api('/api/people/'+encodeURIComponent(person.id));setConflict(latest);}
        catch {message.error(error.message);}
      } else message.error(error.message||'人员档案暂时未能保存');
    } finally {pending.current=false;setSaving(false);}
  }
  return <Modal open title={person?'编辑人员档案':'添加人员'} width={540} onCancel={saving?undefined:onClose} closable={!saving} mask={{closable:!saving}}
    onOk={()=>form.submit()} okText={person?'保存档案':'添加人员'} confirmLoading={saving} okButtonProps={{disabled:Boolean(conflict)||nameTaken}} cancelButtonProps={{disabled:saving}}>
    <p className="person-form-explanation">档案用于分工和记录归属。平台用户的项目访问，仍需通过项目邀请获得。</p>
    {conflict&&<Alert type="warning" showIcon title="档案已有更新，当前输入已保留" style={{marginBottom:18}}
      description={<><p>最新姓名：{conflict.person?.name}；简介：{conflict.person?.bio||'未填写'}。</p><Button size="small" onClick={()=>{setVersion(conflict.revision);setConflict(null);}}>已核对，保留当前输入继续保存</Button></>}/>}
    <Form form={form} layout="vertical" disabled={saving} onFinish={values=>save(values)} onValuesChange={changed=>{if(Object.hasOwn(changed,'name'))setNameTaken(false);}} initialValues={{name:person?.name||'',bio:person?.bio||'',color:person?.color||colors[0]}}>
      <Form.Item name="name" label={person?.accountLinked?'昵称':'姓名'} rules={[{required:true,whitespace:true,message:person?.accountLinked?'请填写昵称':'请填写姓名'}]} validateStatus={nameTaken?'error':undefined} help={nameTaken?'该昵称已被占用':undefined} extra={person?.accountLinked?'账号昵称不能与其他已注册账号重复。':undefined}><Input maxLength={40} autoComplete="off"/></Form.Item>
      <Form.Item name="bio" label="人员简介" extra="可记录擅长领域、协作背景等；项目中的负责方向单独维护。"><Input.TextArea maxLength={1000} showCount rows={4}/></Form.Item>
      <Form.Item name="color" label="头像颜色" getValueFromEvent={value=>typeof value==='string'?value:value.toHexString()}>
        <ColorPicker format="hex" disabledAlpha showText presets={[{label:'常用颜色',colors}]} aria-label="人员头像颜色"/>
      </Form.Item>
    </Form>
    {person&&<p className="person-form-footnote">保存后，同一人员在各项目中的姓名与头像同步更新，任务和成果仍归属原档案。</p>}
  </Modal>;
}

export function MemberManager({state,metadata,onSaved,onWorkspaceRefresh,compact=false,addInitially=false,onAddClosed}) {
  const {message,modal}=AntApp.useApp(),[adding,setAdding]=useState(addInitially),[addingMode,setAddingMode]=useState(isDemo?'existing':'invite');
  const [invite,setInvite]=useState(null),[inviteResult,setInviteResult]=useState(null),[roleEditor,setRoleEditor]=useState(null);
  const [saving,setSaving]=useState(false),[form]=Form.useForm(),[inviteForm]=Form.useForm(),[addInviteForm]=Form.useForm(),[roleForm]=Form.useForm();
  const [people,setPeople]=useState([]),[invitations,setInvitations]=useState([]),[query,setQuery]=useState(''),[loadError,setLoadError]=useState(''),[directoryLoading,setDirectoryLoading]=useState(false);
  const manager=canManage(state)&&state.permissions?.manageMembers!==false,projectId=state.project.id,alive=useRef(true),loadSerial=useRef(0);
  const members=state.members.map(member=>({...metadata?.members?.find(item=>item.id===member.id),...member}));
  const selectablePeople=people.filter(person=>!members.some(member=>member.personId===person.id));
  const nameCounts=new Map();
  for(const person of selectablePeople){const name=normalizedName(person.name);nameCounts.set(name,(nameCounts.get(name)||0)+1);}
  const isSameName=person=>(nameCounts.get(normalizedName(person.name))||0)>1;
  const personOptions=selectablePeople.map(person=>({value:person.id,person,sameName:isSameName(person),
    label:person.name+(person.accountLinked?(isDemo?' · 本地体验身份':' · 平台账号'):' · 人员档案')+(isSameName(person)&&shortPersonId(person.id)?' · '+shortPersonId(person.id):'')}));
  const selectedPersonId=Form.useWatch('personId',form),selectedPerson=people.find(person=>person.id===selectedPersonId);
  const newPersonName=Form.useWatch('name',form);
  const matchingPeople=normalizedName(newPersonName)?people.filter(person=>normalizedName(person.name)===normalizedName(newPersonName)):[];
  const selectedAccount=Boolean(selectedPerson?.accountLinked&&!isDemo);
  useEffect(()=>{if(addInitially)setAdding(true);},[addInitially]);
  async function load() {
    if(!manager)return;
    const serial=++loadSerial.current;setDirectoryLoading(true);
    try {
      const [directory,list]=await Promise.all([manager?api('/api/people?selectableForProject='+encodeURIComponent(projectId)):Promise.resolve({people:[]}),isDemo||!manager?Promise.resolve({invitations:[]}):api('/api/invitations?projectId='+encodeURIComponent(projectId))]);
      if(!alive.current||serial!==loadSerial.current)return;
      setPeople(directory.people||[]);setInvitations(list.invitations||[]);setLoadError('');
    } catch(error) {if(alive.current&&serial===loadSerial.current)setLoadError(error.message);}
    finally {if(alive.current&&serial===loadSerial.current)setDirectoryLoading(false);}
  }
  useEffect(()=>{alive.current=true;load();return()=>{alive.current=false;loadSerial.current++;};},[projectId,manager]);
  function closeAdding(){setAdding(false);onAddClosed?.();}
  function openAdding(mode='existing') {setAddingMode(mode);form.resetFields();addInviteForm.resetFields();setInviteResult(null);setAdding(true);}
  function showInvitation(result,person) {setInvite(person||{});setInviteResult(result.invitation);closeAdding();message.success('邀请链接已生成，等待对方接受');load();}
  async function add(values) {
    if(addingMode==='new') {
      if(directoryLoading||loadError) {message.warning('请先刷新可选择的人员目录，再新建档案');return;}
      if(people.some(person=>normalizedName(person.name)===normalizedName(values.name))) {
        message.warning('可选择目录中已有同名人员，请选择已有档案；不同人员请先到人员目录确认建档。');return;
      }
    }
    setSaving(true);
    try {
      if(addingMode==='existing'&&selectedAccount) {
        const result=await api('/api/invitations',{projectId,personId:values.personId,accessRole:values.accessRole||'member'});
        showInvitation(result,{personId:values.personId,name:selectedPerson.name});return;
      }
      const result=addingMode==='existing'
        ?await api('/api/project-members',{projectId,personId:values.personId,role:values.role,accessRole:values.accessRole||'member'})
        :await api('/api/action',{projectId,type:'addMember',name:values.name,role:values.role});
      onSaved(result.state);onWorkspaceRefresh?.();form.resetFields();closeAdding();
      message.success(isDemo?'人员已加入本地项目分工':'人员档案已加入项目分工');load();
    } catch(error) {message.error(error.message);}
    finally {setSaving(false);}
  }
  function openInvite(member) {setInvite(member||{});setInviteResult(null);inviteForm.resetFields();inviteForm.setFieldsValue({accessRole:member?.accessRole||'member',email:''});}
  async function createInvite(values,fromAdding=false) {
    if(isDemo)return;
    setSaving(true);
    try {
      const result=await api('/api/invitations',{projectId,...(!fromAdding&&invite?.id?{memberId:invite.id}:{}),...values});
      if(fromAdding)showInvitation(result,null);
      else {setInviteResult(result.invitation);message.success('邀请链接已生成，等待对方接受');load();}
    } catch(error) {message.error(error.message);}
    finally {setSaving(false);}
  }
  async function revoke(id) {
    try {await api('/api/invitations/revoke',{id});message.success('邀请已撤销');load();}
    catch(error) {message.error(error.message);}
  }
  function editRole(member) {setRoleEditor({...member,baseRevision:state.revision});roleForm.setFieldsValue({role:member.role||''});}
  async function saveRole(values) {
    setSaving(true);
    try {const result=await api('/api/action',{projectId,type:'updateMember',memberId:roleEditor.id,role:values.role,expectedRevision:roleEditor.baseRevision});
      onSaved(result.state);onWorkspaceRefresh?.();setRoleEditor(null);message.success('本项目负责方向已更新');}
    catch(error) {message.error(error.message);}
    finally {setSaving(false);}
  }
  const visible=members.filter(member=>!query.trim()||(member.name+' '+(member.role||'')).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const invitationForm=(formInstance,fromAdding=false)=><Form form={formInstance} layout="vertical" disabled={saving} onFinish={values=>createInvite(values,fromAdding)} initialValues={{accessRole:'member'}}>
    <p className="person-form-explanation">{!fromAdding&&invite?.id?'对方接受后认领这份原有档案，已有任务与成果归属保留。':'把邀请链接交给对方，由对方登录或注册后确认加入。不会自动发送邮件。'}</p>
    <Form.Item name="email" label="指定接收邮箱（可选）" rules={[{type:'email',message:'请填写有效邮箱'}]}><Input type="email" autoComplete="off"/></Form.Item>
    <Form.Item name="accessRole" label="接受邀请后的项目权限"><Select options={accessOptions}/></Form.Item>
  </Form>;
  const invitingDisabled=isDemo&&addingMode==='invite';
  return <>
    <div className="members-page-heading"><div><h2>{compact?'项目成员':'项目分工与成员'}</h2><p>{state.sample?.version===1?'示例使用固定虚拟伙伴，不邀请或添加真实账号；真实协作请新建自己的空白项目。':'人员档案用于分工，平台账号通过邀请获得项目访问。'}</p></div>{manager&&<Space wrap>
      <Button icon={<LinkOutlined/>} onClick={()=>openAdding('invite')}>邀请账号加入</Button>
      <Button type="primary" icon={<UserAddOutlined/>} onClick={()=>openAdding('existing')}>添加人员</Button>
    </Space>}</div>
    {isDemo&&<p className="people-mode-note">当前仅管理本地档案和分工；真实账号邀请与异地协作需运行完整服务端。</p>}
    {loadError&&<Alert style={{marginBottom:18}} type="warning" showIcon title="人员目录或邀请记录暂未刷新" description={loadError} action={<Button size="small" onClick={load}>重试</Button>}/>}
    <div className="project-members-toolbar"><span><TeamOutlined/>{members.length} 位项目成员</span><Input prefix={<SearchOutlined/>} value={query} onChange={event=>setQuery(event.target.value)} allowClear placeholder="搜索姓名或负责方向" aria-label="搜索项目成员"/></div>
    <div className="project-members-grid">{visible.map(member=>{
      const owned=state.tasks.filter(task=>task.ownerId===member.id),done=owned.filter(task=>task.status==='done').length;
      const reviewing=state.tasks.filter(task=>task.reviewerId===member.id&&task.status==='review').length;
      const menuItems=[...(manager?[{key:'role',label:'编辑本项目负责方向'}]:[]),
        ...(!isDemo&&manager&&!member.accountLinked?[{key:'invite',label:'邀请账号认领档案'}]:[])];
      return <Card key={member.id} className="project-member-card">
        <div className="project-member-card-heading"><Person id={member.id} members={state.members} size={40}/><Space size={4}>
          <Tag className={'member-access '+(member.accountLinked?member.accessRole||'member':'profile')}>{!member.accountLinked?'仅分工档案':accessOptions.find(option=>option.value===member.accessRole)?.label||'项目成员'}</Tag>
          {menuItems.length>0&&<Dropdown menu={{items:menuItems,onClick:({key})=>{if(key==='role')editRole(member);if(key==='invite')openInvite(member);}}}><Button type="text" size="small" icon={<EllipsisOutlined/>} aria-label={'管理'+member.name}/></Dropdown>}
        </Space></div>
        <div className="member-role-label">本项目负责方向</div><p className="member-role">{member.role||'尚未约定负责方向'}</p>
        <div className="member-work-summary"><div><strong>{owned.length-done}</strong><span>负责未完成</span></div><div><strong>{done}</strong><span>已完成</span></div><div><strong>{reviewing}</strong><span>待接收</span></div></div>
        <div className="member-card-footer"><span className={'person-account-state'+(member.accountLinked?' linked':'')}><i/>{isDemo?(member.accountLinked?'本地体验身份':'本地人员档案'):(member.accountLinked?'已关联平台账号':'未授予账号访问')}</span>
          {member.personId&&<Button type="text" size="small" icon={<ArrowRightOutlined/>} aria-label={'查看'+member.name+'的人员档案'} onClick={()=>navigate('/people/'+encodeURIComponent(member.personId))}/>}
        </div>
      </Card>;
    })}</div>
    {!visible.length&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的项目成员"/>}
    {manager&&invitations.length>0&&<section className="invitations-section"><h3>项目邀请</h3><Table size="small" rowKey="id" pagination={false} dataSource={invitations} columns={[
      {title:'邀请对象',render:(_,item)=>item.memberName||item.email||'持有链接的受邀账号'},
      {title:'状态',dataIndex:'status',render:value=>({pending:'待对方接受',accepted:'已接受',revoked:'已撤销',expired:'已过期'})[value]||value},
      {title:'项目权限',dataIndex:'accessRole',render:value=>accessOptions.find(option=>option.value===value)?.label||'项目成员'},
      {title:'有效期',dataIndex:'expiresAt',render:value=>dateLabel(value,true)},
      {title:'',render:(_,item)=>item.status==='pending'?<Button type="link" danger onClick={()=>modal.confirm({title:'撤销邀请？',content:'链接撤销后将无法接受。',onOk:()=>revoke(item.id)})}>撤销</Button>:null},
    ]}/></section>}
    <Modal open={adding} title="添加人员与邀请账号" width={580} mask={{closable:!saving}} closable={!saving} onCancel={saving?undefined:closeAdding} cancelButtonProps={{disabled:saving}}
      onOk={()=>addingMode==='invite'?addInviteForm.submit():form.submit()} confirmLoading={saving} okButtonProps={{disabled:invitingDisabled||addingMode==='new'&&(directoryLoading||Boolean(loadError)||matchingPeople.length>0)}}
      okText={addingMode==='invite'||selectedAccount&&addingMode==='existing'?'生成邀请链接':addingMode==='new'?'新建并加入分工':'加入项目分工'}>
      <Tabs activeKey={addingMode} onChange={value=>{setAddingMode(value);form.resetFields();addInviteForm.resetFields();}} items={[
        {key:'existing',label:'选择已有人员'},{key:'new',label:'新建人员档案'},{key:'invite',label:'邀请账号加入'},
      ]}/>
      {addingMode==='invite'?(isDemo?<div className="people-invite-unavailable"><LinkOutlined/><strong>演示版不生成真实邀请</strong><p>可以在前两个页签添加本地档案并模拟项目分工。账号注册、接受邀请和远程协作需运行完整服务端。</p><Button onClick={()=>setAddingMode('new')}>先创建本地档案</Button></div>:invitationForm(addInviteForm,true))
        :<Form form={form} disabled={saving} layout="vertical" onFinish={add} initialValues={{accessRole:'member'}}>
          {addingMode==='existing'?<>
            <Form.Item name="personId" label="人员档案" rules={[{required:true,message:'请选择人员'}]}><Select showSearch loading={directoryLoading} optionFilterProp="label" placeholder="按姓名查找已有档案" options={personOptions} virtual={false} optionRender={option=><PersonChoice person={option.data.person} disambiguate={option.data.sameName}/>}/></Form.Item>
            {selectedPerson&&<Alert type="info" showIcon style={{marginBottom:18}} title={selectedAccount?'请核对受邀账号对应的人员':'已选择人员档案'} description={<><PersonChoice person={selectedPerson} disambiguate={isSameName(selectedPerson)}/>{selectedAccount&&<p style={{margin:'10px 0 0'}}>邀请只供这份档案绑定的账号接受；对方确认后才加入项目。请核对姓名、简介及同名辨识码。</p>}</>}/>}
            {!selectedAccount&&<Form.Item name="role" label="本项目负责方向" rules={[{required:true,whitespace:true,message:'请约定负责方向'}]}><Input maxLength={80} placeholder="例如：产品设计与用户研究"/></Form.Item>}
            <Form.Item name="accessRole" label={selectedAccount?'接受邀请后的项目权限':isDemo?'本地模拟角色':'账号认领后的项目权限'}><Select options={accessOptions}/></Form.Item>
            {!selectedAccount&&<p className="person-form-footnote">{isDemo?'只调整当前浏览器中的分工，不产生真实账号或远程访问。':'加入档案不会开通账号访问；之后可以邀请本人认领，保留任务与成果。'}</p>}
          </>:<>
            <p className="person-form-explanation">先为项目分工建立档案。姓名、简介和头像可在人员目录中统一维护。</p>
            <Form.Item name="name" label="姓名" rules={[{required:true,whitespace:true,message:'请填写姓名'}]}><Input maxLength={40}/></Form.Item>
            {matchingPeople.length>0&&<Alert type="warning" showIcon title="可选择目录中已有同名人员" style={{marginBottom:18}}
              description={<><p>请先核对已有档案，避免把同一位伙伴重复建档。若确认是不同的人，请到人员目录通过同名确认流程创建独立档案，再回到项目选择。</p><Space wrap><Button size="small" onClick={()=>setAddingMode('existing')}>选择已有人员</Button><Button size="small" onClick={()=>{closeAdding();navigate('/people');}}>前往人员目录</Button></Space></>}/>}
            {loadError&&<Button size="small" onClick={load} style={{marginBottom:16}}>刷新可选择人员目录</Button>}
            <Form.Item name="role" label="本项目负责方向" rules={[{required:true,whitespace:true,message:'请约定负责方向'}]}><Input maxLength={80} placeholder="例如：接口与数据交付"/></Form.Item>
          </>}
        </Form>}
    </Modal>
    <Modal open={Boolean(invite)} width={560} mask={{closable:!saving}} closable={!saving} title={invite?.name?'邀请「'+invite.name+'」加入项目':'邀请账号加入项目'} onCancel={saving?undefined:()=>setInvite(null)}
      footer={inviteResult?<Button onClick={()=>setInvite(null)}>完成</Button>:<Space><Button disabled={saving} onClick={()=>setInvite(null)}>取消</Button><Button type="primary" loading={saving} disabled={isDemo} onClick={()=>inviteForm.submit()}>生成邀请链接</Button></Space>}>
      {inviteResult?<><Alert type="success" showIcon title="邀请链接已生成，等待对方接受" description="请复制给受邀人。链接一次有效，应用不会代发邮件。"/>
        <Input.TextArea className="person-invitation-link" value={new URL(inviteResult.url,location.origin).href} readOnly autoSize aria-label="项目邀请链接"/>
        <Space wrap style={{marginTop:12}}><Button icon={<CopyOutlined/>} onClick={async()=>{try{await navigator.clipboard.writeText(new URL(inviteResult.url,location.origin).href);message.success('已复制邀请链接');}catch{message.info('请选中上方链接手动复制');}}}>复制链接</Button><Text type="secondary">有效至 {dateLabel(inviteResult.expiresAt,true)}</Text></Space>
      </>:invitationForm(inviteForm)}
    </Modal>
    {roleEditor&&<Modal open title={'编辑'+roleEditor.name+'的项目分工'} onCancel={saving?undefined:()=>setRoleEditor(null)} onOk={()=>roleForm.submit()} confirmLoading={saving} okButtonProps={{disabled:roleEditor.baseRevision!==state.revision}} mask={{closable:!saving}}>
      {roleEditor.baseRevision!==state.revision&&<Alert type="warning" showIcon title="项目已有更新，当前输入已保留" style={{marginBottom:16}} description={<><p>最新负责方向：{state.members.find(member=>member.id===roleEditor.id)?.role||"未填写"}。</p><Button size="small" onClick={()=>setRoleEditor({...roleEditor,baseRevision:state.revision})}>已核对，保留输入继续保存</Button></>}/>}
      <Form form={roleForm} layout="vertical" onFinish={saveRole} disabled={saving}><Form.Item name="role" label="本项目负责方向" rules={[{required:true,whitespace:true}]}><Input maxLength={80}/></Form.Item></Form>
      <p className="person-form-footnote">只修改这一个项目的分工，保留人员档案、历史成果和既有访问角色。</p>
    </Modal>}

  </>;
}
