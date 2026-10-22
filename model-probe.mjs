import {AppError} from './domain.mjs';
import {aiStatus} from './planning.mjs';
export async function probeModel(env){
 const status=aiStatus(env);if(!status.configured)throw new AppError('模型服务尚未配置或配置无效',503);
 const key=env.COBUILD_AI_API_KEY.trim(),thinking=env.COBUILD_AI_THINKING?.trim()||undefined;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const response=await fetch(status.baseUrl+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:status.model,stream:false,store:false,[env.COBUILD_AI_TOKEN_PARAMETER||'max_completion_tokens']:256,response_format:{type:'json_object'},messages:[{role:'system',content:'这是连接测试。只返回 JSON 对象 {"ok":true}，不需要解释。'},{role:'user',content:'返回 JSON 连接测试结果。'}],...(thinking?{thinking:{type:thinking}}:{})})});
  if(!response.ok){await response.body?.cancel();throw new AppError('模型服务返回 HTTP '+response.status+'，请核对凭据、模型或账户余额',502);}
  let body='',size=0;const decoder=new TextDecoder();for await(const chunk of response.body){size+=chunk.length;if(size>32768){controller.abort();throw new AppError('模型测试响应超过上限',502);}body+=decoder.decode(chunk,{stream:true});}body+=decoder.decode();
  let data,content;try{data=JSON.parse(body);content=JSON.parse(data.choices?.[0]?.message?.content||'');}catch{throw new AppError('模型未返回有效的连接测试 JSON',502);}
  if(data.choices?.[0]?.finish_reason!=='stop'||content.ok!==true)throw new AppError('模型连接测试输出不完整，请重试',502);
  return {ok:true,model:status.model,message:'模型已返回有效测试结果。本次只发送固定测试文字，没有发送项目资料。'};
 }catch(error){if(error instanceof AppError)throw error;throw new AppError(controller.signal.aborted?'模型连接测试超时':'无法连接模型服务',502);}finally{clearTimeout(timer);}
}
