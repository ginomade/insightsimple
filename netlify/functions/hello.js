// netlify/functions/hello.js
export default async () => {
  return new Response(JSON.stringify({ ok: true, msg: "Hello from Netlify Functions" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
