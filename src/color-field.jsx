import React from 'react';
import {Button,ColorPicker,Input} from 'antd';
import {CheckOutlined} from '@ant-design/icons';
import './color-field.css';

export const PROJECT_COLORS = ['#2f7c67','#557b9b','#8a78a2','#bf914e','#68834c','#bb795c'];
const COLOR_NAMES = ['翡翠','雾蓝','紫色','琥珀','橄榄','陶土'];
export const colorRules = [{required:true,message:'请选择项目颜色'},{pattern:/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i,message:'请输入有效的十六进制颜色，例如 #D65A75'}];

export default function ColorField({value=PROJECT_COLORS[0],onChange,disabled=false}) {
  const valid=/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value||'');
  return <div className="project-color-field">
    <div className="project-color-presets" role="group" aria-label="预设项目颜色">{PROJECT_COLORS.map((color,index)=><button key={color} type="button" disabled={disabled} aria-label={`${COLOR_NAMES[index]} ${color}`} aria-pressed={String(value).toLowerCase()===color} style={{'--swatch':color}} onClick={()=>onChange?.(color)}>{String(value).toLowerCase()===color&&<CheckOutlined/>}</button>)}</div>
    <div className="project-color-custom"><ColorPicker value={valid?value:PROJECT_COLORS[0]} disabled={disabled} disabledAlpha format="hex" presets={[{label:'项目预设',colors:PROJECT_COLORS}]} onChange={color=>onChange?.(color.toHexString())}><Button disabled={disabled} aria-label="打开自选项目颜色"><span className="project-color-swatch" style={{background:valid?value:undefined}}/>自选颜色</Button></ColorPicker><Input aria-label="项目颜色 HEX" disabled={disabled} value={value} maxLength={9} placeholder="#D65A75" onChange={event=>onChange?.(event.target.value.trim())}/></div>
  </div>;
}
