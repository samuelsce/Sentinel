// ruleid: sentinel-no-raw-html
const unsafe = <div dangerouslySetInnerHTML={{__html: "untrusted"}} />;
// ok: sentinel-no-raw-html
const escaped = <div>{"untrusted"}</div>;
