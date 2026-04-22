from __future__ import print_function

import time

from twilio.rest import Client


TWILIO_ACCOUNT_SID = "ACf5ecfbf9e3a6ddc33ea046091ffed50a"
TWILIO_AUTH_TOKEN = None
with open("secrets/twilio_auth_token.txt", mode="r") as twilio_auth_token_file:
    TWILIO_AUTH_TOKEN = twilio_auth_token_file.read()
twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)


TWILIO_PHONE_NUMBER = None
with open("secrets/twilio_phone_number.txt", mode="r") as twilio_phone_number_file:
    TWILIO_PHONE_NUMBER = twilio_phone_number_file.read()


TEO_PHONE_NUMBER = None
with open("secrets/teo_phone_number.txt", mode="r") as teo_phone_number_file:
    TEO_PHONE_NUMBER = teo_phone_number_file.read()


# Time configuration
TWILIO_POLLING_INTERVAL = 2  # Time in seconds between each check
TWILIO_WAIT_DURATION = 30  # Total time in seconds to check the message status


def send_message_wait_for_sent(body):
    original_message = twilio_client.messages.create(
        body=body,
        from_=TWILIO_PHONE_NUMBER,
        to=TEO_PHONE_NUMBER
    )

    start_time = time.time()

    # Loop to check the status
    while time.time() - start_time < TWILIO_WAIT_DURATION:
        message = twilio_client.messages.get(original_message.sid).fetch()
        print("Checking message status...");
        print(f"  Status: {message.status}")
        print(f"  Body: {message.body}")
        print(f"  Date Sent: {message.date_sent}")
        print(f"  Date Updated: {message.date_updated}")
        print(f"  From: {message.from_}")
        print(f"  To: {message.to}")
        print(f"  Price: {message.price}")
        print(f"  API Version: {message.api_version}")
        print(f"  Error Message: {message.error_message}")
        print(f"  Error Code: {message.error_code}")

        if message.status != "sending":
            print("Message left sending status - not checking status anymore")
            break

        # Wait for the next polling cycle
        time.sleep(TWILIO_POLLING_INTERVAL)


def main():
    send_message_wait_for_sent("Hello, this is a message from Twilio!")


if __name__ == '__main__':
    main()
