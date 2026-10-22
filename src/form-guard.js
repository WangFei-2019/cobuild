import {useEffect} from 'react';
import {setNavigationGuard} from './router.js';

export function useFormGuard(dirty,label='当前表单'){
 useEffect(()=>{
  const remove=setNavigationGuard(()=>!dirty.current||window.confirm(`${label}尚未保存，确定放弃并离开？`));
  const warn=event=>{if(dirty.current){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',warn);
  return()=>{remove();window.removeEventListener('beforeunload',warn);};
 },[dirty,label]);
}
