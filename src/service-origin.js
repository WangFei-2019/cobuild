// The Pages entry navigates to a service. It never proxies credentials or project data.
export function normalizeServiceOrigin(value,{allowLocalhost=true}={}) {
 if(typeof value!=='string'||!value.trim())throw new Error('请输入工作区的完整服务地址。');
 const input=value.trim();
 if(/[\u0000-\u0020\\]/.test(input))throw new Error('地址不能包含空格、换行或反斜杠。');
 let url;try{url=new URL(input);}catch{throw new Error('请输入完整地址，例如 https://team.example.com。');}
 if(url.username||url.password)throw new Error('服务地址中不能包含账号或密码。');
 if(url.pathname!=='/'||url.search||url.hash)throw new Error('请填写服务根地址，不包含页面路径、查询参数或邀请令牌。');
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(allowLocalhost&&loopback&&url.protocol==='http:'))throw new Error('正式服务需要 HTTPS；本机调试可使用 http://127.0.0.1:端口。');
 return url.origin;
}
