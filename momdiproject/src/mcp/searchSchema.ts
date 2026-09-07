/** Locate an explicitly advertised person LinkedIn URL filter. Never guess a name from a URL. */
export function linkedInSearchArguments(schema: any, url: string): Record<string, unknown> | null {
  const resolve = (node: any): any => {
    if (typeof node?.$ref !== 'string' || !node.$ref.startsWith('#/')) return node;
    return node.$ref.slice(2).split('/').reduce((v:any,k:string)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],schema) || node;
  };
  const kinds = (node:any, depth=0):string[] => {
    if (!node || depth>8) return [];
    node=resolve(node);
    return [...(Array.isArray(node.type)?node.type:node.type?[node.type]:[]),...['anyOf','oneOf','allOf'].flatMap(k=>(node[k]||[]).flatMap((n:any)=>kinds(n,depth+1)))];
  };
  const names = new Set(['linkedinurl','linkedinurls','linkedinprofileurl','linkedinprofileurls','liprofileurl','liprofileurls','contactlinkedinurl','contactlinkedinurls','contactlinkedinprofileurl','contactlinkedinprofileurls']);
  const visit = (node:any,path:string[],depth=0):Record<string,unknown>|null => {
    if (!node || depth>8) return null;
    node=resolve(node);
    for (const [key, original] of Object.entries(node.properties||{})) {
      const property=resolve(original),name=key.toLowerCase().replace(/[^a-z]/g,'');
      const types=kinds(property);
      if(names.has(name) && (types.includes('array')||types.includes('string'))) {
        let value:any=types.includes('array')?[url]:url;
        for(const part of [...path,key].reverse()) value={[part]:value};
        return value;
      }
    }
    for(const [key,property] of Object.entries(node.properties||{})) {
      if(kinds(property).includes('object') || (property as any)?.properties) {
        const found=visit(property,[...path,key],depth+1);if(found)return found;
      }
    }
    for(const keyword of ['allOf','anyOf','oneOf']) for(const branch of node[keyword]||[]) {
      const found=visit(branch,path,depth+1);if(found)return found;
    }
    return null;
  };
  return visit(schema,[]);
}
