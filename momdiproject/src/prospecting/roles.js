'use strict';

const FLAGGED = [
  role('flagged-it-manager','IT Manager',[
    'Information Technology Manager','Manager of Information Technology','Manager of IT','ICT Manager','Information and Communication Technology Manager','Tech Manager','Technology Manager','MIS Manager','Management Information Systems Manager','IS Manager','Information Systems Manager','IT Department Manager','IT Lead','Lead IT Manager','Senior IT Manager','Regional IT Manager','Global IT Manager','Corporate IT Manager','Group IT Manager','Site IT Manager'
  ]),
  role('flagged-it-director','IT Director',[
    'Information Technology Director','Director of Information Technology','Director of IT','ICT Director','Technology Director','Tech Director','MIS Director','IS Director','Director of Information Systems','Senior Director of IT','Executive Director of IT','Regional IT Director','Global IT Director','Corporate IT Director','Associate IT Director'
  ]),
  role('flagged-head-it','Head of IT',[
    'Head of Information Technology','IT Head','Head of ICT','Head of Tech','Head of Technology','Head of MIS','IT Leader','Top IT Leader','Global Head of IT','Regional Head of IT','Group Head of IT'
  ]),
  role('flagged-vp-it','VP of IT',[
    'Vice President of IT','Vice President of Information Technology','VP Information Technology','VP of Technology','Vice President of Technology','VP of Information Systems','VP of ICT','SVP of IT','Senior Vice President of IT','EVP of IT','Executive Vice President of IT','AVP of IT','Associate Vice President of IT','Assistant Vice President of IT','CVP of IT','Corporate Vice President of IT'
  ]),
  role('flagged-cio-cto','CIO / CTO',[
    'CIO','CTO','Chief Information Officer','Chief Technology Officer','Chief IT Officer','Head of Technology','Top Technology Executive','Chief Digital Information Officer','CDIO','Chief Innovation Officer','Global CIO','Global CTO','Deputy CIO','Fractional CIO','Virtual CIO','vCIO','Fractional CTO'
  ]),
  role('flagged-system-administrator','System Administrator',[
    'Systems Administrator','System Admin','SysAdmin','Systems Engineer','IT Systems Administrator','Computer Systems Administrator','Server Administrator','Infrastructure Administrator','Systems Operations Administrator','Windows System Administrator','Linux System Administrator','Unix System Administrator','Wintel Administrator','Active Directory Administrator','O365 Administrator','Microsoft 365 Administrator','Senior System Administrator','Lead SysAdmin','Junior System Administrator','Systems Administrator I','Systems Administrator II','Systems Administrator III'
  ]),
  role('flagged-network-manager','Network Manager',[
    'Manager of Networks','IT Network Manager','Network Operations Manager','Network Engineering Manager','Head of Networking','Network Administration Manager','Telecom & Network Manager','Telecom and Network Manager','LAN/WAN Manager','Manager of Network Infrastructure','Senior Network Manager','Global Network Manager','Director of Networking'
  ]),
  role('flagged-it-security-manager','IT Security Manager',[
    'Information Technology Security Manager','Manager of IT Security','Information Security Manager','ISM','InfoSec Manager','Manager of Information Security','Corporate IT Security Manager','IT Risk & Security Manager','IT Risk and Security Manager','ISMS Manager','Information Security Management System Manager','Senior IT Security Manager','Global Information Security Manager'
  ]),
  role('flagged-infrastructure-manager','IT Infrastructure Manager',[
    'Information Technology Infrastructure Manager','Manager of IT Infrastructure','Infrastructure Operations Manager','IT Systems & Infrastructure Manager','IT Systems and Infrastructure Manager','Head of Infrastructure','Infrastructure Engineering Manager','IT Infrastructure Operations Lead','Core Infrastructure Manager','Senior Infrastructure Manager','Global IT Infrastructure Manager'
  ]),
  role('flagged-cybersecurity-manager','Cybersecurity Manager',[
    'Cyber Security Manager','Manager of Cybersecurity','Manager of Cyber Operations','Cyber Risk Manager','Manager of Threat & Vulnerability','Manager of Threat and Vulnerability','Cyber Defense Manager','Security Operations Center Manager','SOC Manager','SOC Lead','Cyber Incident Response Manager',
    // High-value adjacent titles used by large enterprises instead of the literal "Cybersecurity Manager".
    'Information Security Manager','InfoSec Manager','Manager of Information Security','Security Engineering Manager','Security Operations Manager','Cybersecurity Program Manager','Cyber Security Program Manager','Security Risk Manager','Enterprise Security Manager','Product Security Manager','Application Security Manager','Cloud Security Manager'
  ]),
  role('flagged-end-user-manager','End User Manager',[
    'Manager of End User Services','End User Computing Manager','EUC Manager','Digital Workplace Manager','Employee Experience Technology Manager','End User Technology Manager','Client Computing Manager','Endpoint Services Manager','Workspace Technology Manager'
  ]),
  role('flagged-help-desk-manager','Help Desk Manager',[
    'IT Help Desk Manager','Manager of the Help Desk','Service Desk Manager','IT Support Manager','Technical Support Manager','IT Service Desk Manager','Helpdesk Operations Manager','Manager of IT Support Services','Customer Support Manager','Desktop Support Manager','L1 Support Manager','L2 Support Manager','L1/L2 Support Manager'
  ])
];

const NOT_FLAGGED = [
  role('not-ceo','CEO',[
    'Chief Executive Officer','Chief Executive','President','Managing Director','MD','Executive Director','Principal','Chief Executive Officer & President','Chief Executive Officer and President'
  ]),
  role('not-cofounder','Co-Founder',[
    'Co founder','Co-Founder','Cofounder','Founding Partner','Co-Creator','Founding Member','Joint Founder','Startup Co-Founder'
  ]),
  role('not-founder','Founder',[
    'Creator','Principal Founder','Sole Founder','Founding CEO','Founding Director','Original Founder'
  ]),
  role('not-owner','Owner',[
    'Business Owner','Proprietor','Sole Proprietor','Principal Owner','Co-Owner','Managing Owner','Managing Partner','Business Principal'
  ]),
  role('not-cto-cio','CTO / CIO',[
    'CTO','CIO','Chief Technology Officer','Chief Information Officer','Chief IT Officer','Chief Digital Information Officer','CDIO','VP of Engineering','Vice President of Engineering','Chief Architect','Global CIO','Global CTO','Deputy CIO','Fractional CIO','Virtual CIO','vCIO','Fractional CTO'
  ]),
  role('not-it-leadership','IT Manager / Head of IT / IT Director',[
    ...aliasesOf(FLAGGED,'flagged-it-manager'),...aliasesOf(FLAGGED,'flagged-head-it'),...aliasesOf(FLAGGED,'flagged-it-director')
  ]),
  role('not-head-data','Head of Data',[
    'Head of Data Science','Head of Data and Analytics','Chief Data Officer','CDO','Chief Data & Analytics Officer','Chief Data and Analytics Officer','CDAO','Director of Data','Director of Data Engineering','VP of Data','Vice President of Data','Data Manager','Lead Data Scientist','Head of Business Intelligence','Head of BI','Head of Data Architecture'
  ]),
  role('not-it-admin','IT Admin',[
    'IT Administrator','Information Technology Administrator','General IT Admin','Tech Admin','Office IT Administrator','IT Support Administrator','Network & IT Admin','Network and IT Admin','Computer Administrator','Systems and Network Administrator'
  ]),
  role('not-transformation-manager','IT Transformation Manager',[
    'Information Technology Transformation Manager','Digital Transformation Manager','Business IT Transformation Manager','Technology Transformation Lead','Change Manager IT','IT Change Manager','IT Modernization Manager','Agile Transformation Manager','Head of Digital Transformation','IT Strategy Manager'
  ]),
  role('not-cloud-manager','IT Cloud Manager / Cloud Manager',[
    'Information Technology Cloud Manager','Cloud Manager','Cloud Operations Manager','Cloud Infrastructure Manager','Manager of Cloud Services','Head of Cloud','Cloud Architecture Manager','Director of Cloud Technologies','Cloud Platform Manager','AWS Cloud Manager','Azure Operations Manager','GCP Cloud Lead','Cloud Solutions Manager'
  ]),
  role('not-devops-manager','Head of DevOps / DevOps Manager',[
    'Head of Development and Operations','Manager of DevOps','DevOps Manager','Platform Engineering Manager','Head of Platform Engineering','DevSecOps Manager','Site Reliability Engineering Manager','SRE Manager','Head of SRE','Director of DevOps','Release Engineering Manager','Build and Release Manager','Cloud & DevOps Manager','Cloud and DevOps Manager'
  ]),
  role('not-it-security-manager','IT Security Manager',aliasesOf(FLAGGED,'flagged-it-security-manager')),
  role('not-it-operations-manager','IT Operations Manager',[
    'Information Technology Operations Manager','Manager of IT Operations','Head of IT Operations','IT Ops Manager','Director of IT Operations','Global IT Operations Manager','IT Service Delivery Manager','IT Operations Center Manager','ITOC Manager'
  ]),
  role('not-head-infrastructure','Head of IT Infrastructure',[
    'Head of Information Technology Infrastructure','Director of Infrastructure','VP of Infrastructure','Vice President of Infrastructure','Global Head of Infrastructure','Infrastructure and Operations Head','I&O Head','Chief Infrastructure Officer','Head of Core IT'
  ]),
  role('not-system-administrator','System Administrator',aliasesOf(FLAGGED,'flagged-system-administrator'))
];

function role(id,label,aliases){
  const all=[label,...aliases].map(v=>String(v).trim()).filter(Boolean);
  return {id,label,aliases:[...new Set(all)]};
}
function aliasesOf(group,id){return group.find(r=>r.id===id)?.aliases||[]}
function groups(){return {flagged:FLAGGED,not_flagged:NOT_FLAGGED}}
function allRoles(){return [...FLAGGED,...NOT_FLAGGED]}
function getRoles(ids,groupName){
  const group=groups()[groupName]||[];
  if(!Array.isArray(ids)||!ids.length)return group;
  const set=new Set(ids);return group.filter(r=>set.has(r.id));
}
function publicRoleGroups(){return {flagged:FLAGGED.map(publicRole),not_flagged:NOT_FLAGGED.map(publicRole)}}
function publicRole(r){return {id:r.id,label:r.label,aliasCount:r.aliases.length,aliases:r.aliases}}
module.exports={FLAGGED,NOT_FLAGGED,groups,allRoles,getRoles,publicRoleGroups};
