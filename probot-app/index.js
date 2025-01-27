import { Octokit } from '@octokit/rest';
import { WebClient } from '@slack/web-api';
import axios from 'axios';
import * as openpgp from 'openpgp';

// Helper functions remain the same
async function downloadGPGFile(url) {
  console.debug(`Downloading GPG file from: ${url}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  console.debug(`GPG file downloaded successfully`);
  return new Uint8Array(response.data);
}

async function decryptGPGData(encryptedData, passphrase) {
  console.debug(`Decrypting GPG file in memory`);
  
  const message = await openpgp.readMessage({
    binaryMessage: encryptedData
  });

  const { data: decrypted } = await openpgp.decrypt({
    message,
    passwords: [passphrase],
    format: 'utf8',
  });

  console.debug(`File decrypted successfully`);
  return decrypted;
}

async function getSlackUserId(githubUsername, userMapUrl, userMapPassphrase) {
  console.debug(`Fetching Slack user ID for GitHub username: ${githubUsername}`);

  const encryptedData = await downloadGPGFile(userMapUrl);
  const decryptedJson = await decryptGPGData(encryptedData, userMapPassphrase);

  const userMap = JSON.parse(decryptedJson);
  const slackUserId = userMap[githubUsername];

  console.debug(`Slack user ID for ${githubUsername}: ${slackUserId}`);
  return slackUserId;
}

async function notifySlack(channel, message, slackToken) {
  console.debug(`Sending Slack notification to channel: ${channel}`);
  try {
    await axios.post(
      "https://slack.com/api/chat.postMessage",
      {
        channel,
        text: message,
        unfurl_links: false,
        unfurl_media: false,
      },
      {
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.debug('Slack notification sent successfully');
  } catch (error) {
    console.error("Error sending Slack message:", error);
    throw error;
  }
}

// New helper function to get PR details
async function getPullRequestDetails(owner, repo, commitSha, octokit) {
  console.debug(`Fetching PR details for commit: ${commitSha}`);
  const { data: prs } = await octokit.search.issuesAndPullRequests({
    q: `${commitSha} type:pr repo:${owner}/${repo}`,
  });

  if (prs.items.length === 0) {
    console.debug('No PR found for this commit');
    return null;
  }

  const prNumber = prs.items[0].number;
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return pr;
}

// Main Lambda handler
export const handler = async (event) => {
  console.log('Lambda handler started');
  console.log('Event received:', JSON.stringify(event, null, 2));

  // Initialize clients with environment variables
  const slackToken = process.env.SLACK_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  const userMapUrl = process.env.USER_MAP_URL;
  const userMapPassphrase = process.env.GPG_USER_MAP_PASSPHRASE;
  const slackCommonChannel = process.env.SLACK_COMMON_CHANNEL;
  const slackFailureChannel = process.env.SLACK_FAILURE_CHANNEL;

  console.log('Environment variables loaded:', {
    hasSlackToken: !!slackToken,
    hasGithubToken: !!githubToken,
    hasUserMapUrl: !!userMapUrl,
    hasUserMapPassphrase: !!userMapPassphrase,
    slackCommonChannel,
    slackFailureChannel,
  });

  const octokit = new Octokit({ auth: githubToken });

  try {
    // Parse the GitHub webhook payload
    const githubEvent = event.headers['X-GitHub-Event'] || event.headers['x-github-event'];
    const payload = JSON.parse(event.body);
    
    console.log('Processing GitHub webhook:', {
      eventType: githubEvent,
      repository: payload.repository?.full_name,
      action: payload.action,
    });

    // Handle check suite event
    if (githubEvent === 'check_suite' && payload.action === 'completed') {
      const checkSuite = payload.check_suite;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;

      console.log('Processing check suite event:', {
        status: checkSuite.status,
        conclusion: checkSuite.conclusion,
        headCommit: checkSuite.head_sha,
      });

      // Only process if the check suite is complete and failed
      if (checkSuite.status === 'completed' && checkSuite.conclusion === 'failure') {
        console.log('Failed check suite detected');

        // Get the first failed check from the check suite
        const { data: checks } = await octokit.checks.listForSuite({
          owner,
          repo,
          check_suite_id: checkSuite.id,
        });

        const failedCheck = checks.check_runs.find(check => check.conclusion === 'failure');
        
        if (failedCheck) {
          // Get associated PR details
          const pr = await getPullRequestDetails(owner, repo, checkSuite.head_sha, octokit);
          
          if (pr && ['open', 'closed'].includes(pr.state)) {
            console.log('Associated PR found:', {
              number: pr.number,
              state: pr.state,
              merged: pr.merged,
            });

            // Handle PR closed/merged case
            if (pr.state === 'closed') {
              if (pr.merged && slackFailureChannel) {
                const message = `🚨 *Build Failure Detected After PR Merge!*\n- *Repository*: ${repo}\n- *Workflow*: ${failedCheck.name}\n- *Failed Checks*: ${failedCheck.html_url}`;
                await notifySlack(slackFailureChannel, message, slackToken);
              }
            }
            // Handle open PR case
            else {
              const slackUserId = await getSlackUserId(pr.user.login, userMapUrl, userMapPassphrase);
              console.log('Slack user lookup result:', {
                githubUsername: pr.user.login,
                slackUserId: slackUserId || 'not found',
              });

              const message = `🚨 *Build Failure Detected!*\n- *Repository*: ${repo}\n- *Workflow*: ${failedCheck.name}\n- *Commit*: ${checkSuite.head_sha}\n- *Failed Checks*: ${failedCheck.html_url}\n- *PR*: <${pr.html_url}>\nPlease address these issues before merging.`;

              if (slackUserId) {
                await notifySlack(slackUserId, message, slackToken);
              } else if (slackCommonChannel) {
                console.log('User not found in mapping, notifying common channel');
                const fallbackMessage = `🚨 Build Failure Detected!\nRepository: ${repo}\nWorkflow: ${failedCheck.name}\nCommit: ${checkSuite.head_sha}\nFailed Checks: ${failedCheck.html_url}\nPR: ${pr.html_url}\n(*${pr.user.login}*) not found in user_map.json, notifying the common channel instead.`;
                await notifySlack(slackCommonChannel, fallbackMessage, slackToken);
              }
            }
          }
        }
      }
    }

    console.log('Webhook processed successfully');
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Webhook processed successfully' }),
    };
  } catch (error) {
    console.error('Error processing webhook:', error.stack);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};