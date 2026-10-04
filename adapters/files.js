import {inspectPng} from '../core/assets.mjs';
import {LIMITS} from '../core/world.mjs';
export async function chooseFiles({multiple=false,accept='.wld'}={}) {
 // #ifdef H5
 return await new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept=accept;input.multiple=multiple;input.onchange=()=>resolve(Array.from(input.files||[]));input.oncancel=()=>resolve([]);input.click();});
 // #endif
 // #ifdef MP-WEIXIN
 return await new Promise((resolve,reject)=>wx.chooseMessageFile({count:multiple?100:1,type:'file',success:r=>resolve(r.tempFiles),fail:e=>String(e.errMsg).includes('cancel')?resolve([]):reject(e)}));
 // #endif
}
export async function readBytes(file,maxBytes=LIMITS.fileBytes){
 if(file.size>maxBytes)throw new Error('文件超出大小限制');
 // #ifdef H5
 const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length>maxBytes)throw new Error('文件超出大小限制');return bytes;
 // #endif
 // #ifdef MP-WEIXIN
 return await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.path,success:r=>{const bytes=new Uint8Array(r.data);bytes.length>maxBytes?reject(new Error('文件超出大小限制')):resolve(bytes);},fail:reject}));
 // #endif
}
export async function saveText(text,name){
 // #ifdef H5
 const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return name;
 // #endif
 // #ifdef MP-WEIXIN
 const path=`${wx.env.USER_DATA_PATH}/${name}`;await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:path,data:text,encoding:'utf8',success:resolve,fail:reject}));return path;
 // #endif
}
export async function loadTexture(file,canvas){
 const info=inspectPng(await readBytes(file,8*1024*1024));
 return await new Promise((resolve,reject)=>{let image,url;
 // #ifdef H5
 image=new Image();url=URL.createObjectURL(file);
 // #endif
 // #ifdef MP-WEIXIN
 image=canvas.createImage();url=file.path;
 // #endif
 image.onload=()=>{
 // #ifdef H5
 URL.revokeObjectURL(url);
 // #endif
 if(image.width!==info.width||image.height!==info.height){reject(new Error('贴图解码尺寸过大'));return;}resolve(image);};image.onerror=()=>reject(new Error('PNG 贴图解码失败'));image.src=url;});
}
