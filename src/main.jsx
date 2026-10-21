import React from 'react';
import {createRoot} from 'react-dom/client';
import {App,ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Application from './App.jsx';
import 'antd/dist/reset.css';
import './styles.css';
createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#265f9c',colorSuccess:'#168477',fontSize:14,fontSizeSM:12,borderRadius:6,controlHeight:32,fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'},components:{Table:{headerBg:'#fafafa',cellPaddingBlock:16},Tabs:{horizontalItemGutter:28},Drawer:{paddingLG:24},Modal:{borderRadiusLG:8},Card:{headerFontSize:15}}}}><App><Application/></App></ConfigProvider>);
