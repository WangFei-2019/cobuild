// Bundled during build so a verified release needs no runtime package install.
import {createTransport} from 'nodemailer';
export function createSMTPTransport(options){return createTransport({...options,pool:false,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});}
