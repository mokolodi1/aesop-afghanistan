import base64
from email.message import EmailMessage
import logging
import time

from phonebuddies.EmailDraft import EmailDraft
from phonebuddies.GoogleServiceProvider import GoogleServiceProvider
from phonebuddies.ResultTracker import ResultTracker


class EmailSender:
    """
    Singleton class that actually does the email sending
    """

    _BETWEEN_EMAIL_PAUSE_SECS = 2
    _instance = None
    _really_send_emails = False

    @staticmethod
    def get_instance():
        if EmailSender._instance is None:
            EmailSender._instance = EmailSender()

        return EmailSender._instance

    def __init__(self):
        if EmailSender._instance is not None:
            raise Exception("This class is a singleton!")
        
        self.service = GoogleServiceProvider.gmail_service()


    def enable_email_sending(self):
        """
        Call this method in order to really send emails. Otherwise, emails will not actually send.
        """
        self._really_send_emails = True


    def __rate_limit_emails():
        """
        This is some relatively complex Python that "decorates" the send_email method.
        Simply put, wrapped() is called right before each time the decorated method (send_email) is called.
        In this case, we pause execution a bit before running the method so we don't send too many emails.
        """
        def decorator(func):
            def wrapped(*args, **kwargs):
                # Only rate limit if the emails are actually going to be sent out
                sender = EmailSender.get_instance()

                if sender._really_send_emails:
                    time.sleep(sender._BETWEEN_EMAIL_PAUSE_SECS)

                return func(*args, **kwargs)
            return wrapped
        return decorator

    @__rate_limit_emails()
    def send_email(self, draft: EmailDraft):
        """
        Based on code from Google:
        https://developers.google.com/gmail/api/guides/sending#python
        """
        try:
            message = EmailMessage()

            if isinstance(draft.to, str):
                message['To'] = draft.to
            else:
                message['To'] = ", ".join(draft.to)
            message['From'] = draft.coming_from
            message['Subject'] = draft.subject

            if "<body>" in draft.contents:
                message.set_content(draft.contents, subtype="html")
            else:
                message.set_content(draft.contents)

            # encoded message
            create_message = {
                'raw': base64.urlsafe_b64encode(message.as_bytes()).decode()
            }

            to_send = self.service.users().messages().send(userId="me", body=create_message)

            if self._really_send_emails:
                to_send.execute()
                logging.info("Email sent: %s" % draft)
            else:
                logging.info("Email not sent (but would have been): %s" % draft)
        except Exception as e:
            ResultTracker.add_issue("Issue sending email %s: %s" % (str(draft), str(e)), save_traceback=True)
        