import React from 'react';
import {createRoot} from 'react-dom/client';
import {App,ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Application from './App.jsx';
import 'antd/dist/reset.css';
import './styles.css';
createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#2f7c67',colorSuccess:'#2f7c67',colorWarning:'#c67b54',colorError:'#bd5d50',colorText:'#182b36',colorTextSecondary:'#748078',colorBorder:'#dde3dc',colorBgLayout:'#f6f7f4',fontSize:14,fontSizeSM:12,borderRadius:8,controlHeight:34,fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'},components:{Table:{headerBg:'#f5f7f3',cellPaddingBlock:14,headerColor:'#66766e'},Tabs:{horizontalItemGutter:28},Drawer:{paddingLG:24},Modal:{borderRadiusLG:12},Card:{headerFontSize:15,borderRadiusLG:12},Button:{primaryShadow:'0 2px 3px rgba(25,65,49,.08)'},Input:{activeShadow:'0 0 0 2px rgba(47,124,103,.08)'}}}}><App><Application/></App></ConfigProvider>);
