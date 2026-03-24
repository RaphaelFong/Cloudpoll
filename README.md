# CloudPoll - EC2 Deployment Guide (Team Reference)

- **Note**: Use the public IPv4 address listed on the CloudPoll instance. It will be renewed whenever the server closes

## What we have running

- **App URL**: http://34.229.146.157:3000
- **EC2 Instance**: CloudPoll-Server (t3.micro, Amazon Linux 2023)
- **Region**: US East (N. Virginia) / us-east-1
- **Database**: DynamoDB table `CloudPoll-Sessions`
- **AWS Account**: Raphael's Learner Lab (Account ID: 2663-0488-9465)

---

## How the EC2 instance works

The EC2 instance is a Linux computer running 24/7 in an AWS data center in Virginia. Our Node.js app runs on it so anyone in the world can access CloudPoll via the public IP.

- The instance, DynamoDB table, and all AWS resources are on **Raphael's AWS account**. Teammates cannot see or manage the AWS console — only Raphael can.
- However, anyone with SSH access (the `.pem` key file) can connect to the EC2 machine and run commands on it.

---

## Connecting to the EC2 instance (SSH)

SSH = remote controlling the EC2 machine through a terminal.

### From Learner Lab terminal (recommended)

1. Go to your Learner Lab page, open the terminal
2. Run:
```bash
ssh -i ~/.ssh/labsuser.pem ec2-user@34.229.146.157
```
3. Type `yes` (the full word) when asked about connecting
4. You're in when you see: `[ec2-user@ip-172-31-27-217 ~]$`
5. Or can verify with "whoami" command, you will see ec2user

### Important notes

- The **public IP will change** if the instance is stopped and restarted. Check the EC2 console for the new IP.
- Only Raphael's Learner Lab has the SSH key. If teammates need access, Raphael needs to share the Learner Lab terminal or create additional key pairs.

---

## Useful commands (run on EC2 via SSH)

### Check if the server is running
```bash
ps aux | grep node
```

### View server logs
```bash
cat ~/Cloudpoll/output.log
```

### Stop the server
```bash
pkill -f "node server.js"
```

### Start the server (stays alive after closing terminal)
```bash
cd ~/Cloudpoll
nohup node server.js > output.log 2>&1 &
```

**What this command does:**
- `nohup` = "no hang up" — keeps the process running even after you close the terminal
- `> output.log` = saves all console output to a file called output.log
- `2>&1` = also captures error messages into the same file
- `&` = runs it in the background so you get your terminal back

### Update code from GitHub
```bash
cd ~/Cloudpoll
pkill -f "node server.js"
git pull
npm install
nohup node server.js > output.log 2>&1 &
```

---

### To save money when not working

1. Go to EC2 > Instances
2. Select CloudPoll-Server
3. Click **Instance state > Stop instance**
4. This pauses billing (storage cost is negligible)
5. To resume: **Instance state > Start instance**
6. **Important**: The public IP changes after restart — check the new IP in the console

### Don't terminate!

- **Stop** = pause (can restart later, data preserved)
- **Terminate** = delete permanently (everything gone)

---

## Workflow for updating code

1. **Everyone** works locally on their own PC and pushes to GitHub
2. **Raphael** (or whoever has SSH access) connects to EC2 and pulls the latest code:

```bash
# On EC2
cd ~/Cloudpoll
pkill -f "node server.js"
git pull
npm install
nohup node server.js > output.log 2>&1 &
```

Do NOT have multiple people editing files directly on the EC2 machine.

---

## Dependency 
This is dll for dynamoDB, done for the VM, only run this on your cmd if running localhost

run:
npm install jsonwebtoken bcryptjs @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb

## Security group (firewall) rules

| Port | Type       | Source    | Purpose                    |
|------|------------|-----------|----------------------------|
| 22   | SSH        | 0.0.0.0/0 | Remote terminal access    |
| 80   | HTTP       | 0.0.0.0/0 | Web traffic (future use)  |
| 3000 | Custom TCP | 0.0.0.0/0 | Node.js server            |

---