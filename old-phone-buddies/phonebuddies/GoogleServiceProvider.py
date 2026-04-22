from functools import cache
import os.path
from urllib.parse import parse_qs, urlparse
import sys

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build


# NOTE: When modifying these scopes, delete the file token.json.
SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    "https://www.googleapis.com/auth/spreadsheets"
]

AUTH_INSTRUCTIONS = """Please go to the following URL and finish the authentication process. \
After you complete the process, you will be forwarded to a URL that will appear to be broken - this is normal. \
You will copy and paste that URL here in order to complete the authentication process."""


class GoogleServiceProvider:
    @staticmethod
    @cache
    def __get_credentials():
        creds = None

        # The file token.json stores the user's access and refresh tokens, and is
        # created automatically when the authorization flow completes for the first
        # time.
        if os.path.exists('token.json'):
            creds = Credentials.from_authorized_user_file('token.json', SCOPES)

        # If there are no (valid) credentials available, let the user log in.
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    'secrets/credentials.json', SCOPES)

                # Use a local server for the redirect_uri
                redirect_url = 'http://localhost:8080/'
                flow.redirect_uri = redirect_url

                auth_url, _ = flow.authorization_url(prompt='consent')

                print(AUTH_INSTRUCTIONS)
                print()
                print(auth_url)
                print()

                retry_auth_attempts = 0
                max_retry_auth_attempts = 5
                while retry_auth_attempts < max_retry_auth_attempts:
                    url = input("Enter the URL you are forwarded to (which appears broken and starts with %s): " % redirect_url)

                    parsed_url = urlparse(url)
                    query_params = parse_qs(parsed_url.query)
                    auth_code = query_params.get("code", [None])[0]

                    if auth_code:
                        try:
                            flow.fetch_token(code=auth_code)
                            creds = flow.credentials
                            break  # Exit the loop on successful authentication
                        except Exception as e:
                            print(f"Failed to fetch authentication token. Error: {e}. Attempts left: {(max_retry_auth_attempts - retry_auth_attempts - 1)}")
                    else:
                        print(f"Invalid URL or authorization code. Please ensure the URL starts with {redirect_url}. Attempts left: {(max_retry_auth_attempts - retry_auth_attempts - 1)}")

                    retry_auth_attempts += 1

                if retry_auth_attempts >= max_retry_auth_attempts:
                    print(f"Maximum number of authentication attempts reached: {max_retry_auth_attempts}. Authentication failed.")
                    sys.exit(1) # Exit the program if authentication fails

        if creds:
            creds.refresh(Request())
            with open('token.json', 'w') as token:
                token.write(creds.to_json())
            return creds
        else:
            print("Failed to obtain valid credentials.")
            sys.exit(1) # Exit the program if credentials could not be obtained

    @staticmethod
    def sheets_service():
        return build('sheets', 'v4', credentials=GoogleServiceProvider.__get_credentials())

    @staticmethod
    def gmail_service():
        return build('gmail', 'v1', credentials=GoogleServiceProvider.__get_credentials())